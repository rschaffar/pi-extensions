import type { ChildProcess } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import type { ModelRegistry, ProviderConfig } from "@earendil-works/pi-coding-agent";
import {
	CHILD_AUTH_PRELUDE_FD,
	CHILD_AUTH_PROTOCOL,
	CHILD_AUTH_READ_FD,
	CHILD_AUTH_WRITE_FD,
	type ChildAuthAck,
	type ChildAuthProviderSnapshot,
	type ChildAuthSnapshot,
	MAX_CHILD_AUTH_ACK_BYTES,
	parseChildAuthAck,
	parseChildAuthSnapshot,
	serializeChildAuthPrelude,
	serializeChildAuthRequest,
} from "./child-auth-protocol.js";

export const CHILD_AUTH_BOOTSTRAP_PATH = fileURLToPath(
	new URL("./child-auth-bootstrap.ts", import.meta.url),
);

const DEFAULT_AUTH_ACK_TIMEOUT_MS = 30_000;
const SERIALIZABLE_PROVIDER_FIELDS = ["name", "baseUrl", "api", "authHeader", "models"] as const;

type RegisteredProviderConfig = NonNullable<
	ReturnType<ModelRegistry["getRegisteredProviderConfig"]>
>;

export async function createChildAuthSnapshot(
	modelRegistry: ModelRegistry,
	selectedProviderIds?: readonly string[],
): Promise<ChildAuthSnapshot> {
	const compatibleRegistry = modelRegistry as ModelRegistry & {
		getAll?: ModelRegistry["getAll"];
		getRegisteredProviderIds?: ModelRegistry["getRegisteredProviderIds"];
	};
	const providerIds = new Set(
		selectedProviderIds ?? (compatibleRegistry.getAll?.() ?? []).map((model) => model.provider),
	);
	if (!selectedProviderIds) {
		for (const providerId of compatibleRegistry.getRegisteredProviderIds?.() ?? []) {
			providerIds.add(providerId);
		}
	}
	const providers: ChildAuthProviderSnapshot[] = [];
	for (const provider of [...providerIds].sort((left, right) => left.localeCompare(right))) {
		let source: ReturnType<ModelRegistry["getProviderAuthStatus"]>["source"];
		try {
			source = modelRegistry.getProviderAuthStatus(provider).source;
		} catch {
			throw new Error("Unable to inspect parent runtime authentication status");
		}
		if (source !== "runtime") continue;
		let nativeProvider: unknown;
		try {
			nativeProvider = compatibleRegistry.getRegisteredNativeProvider?.(provider);
		} catch {
			throw new Error("Unable to inspect parent runtime provider configuration");
		}
		if (nativeProvider) {
			throw new Error(
				"Parent runtime provider requires executable native configuration that cannot cross the child process boundary",
			);
		}
		let resolved: Awaited<ReturnType<ModelRegistry["getProviderAuth"]>>;
		try {
			resolved = await modelRegistry.getProviderAuth(provider);
		} catch {
			throw new Error("Unable to resolve parent runtime authentication");
		}
		if (
			!resolved ||
			(!resolved.auth.apiKey &&
				!resolved.auth.baseUrl &&
				Object.keys(resolved.auth.headers ?? {}).length === 0)
		) {
			throw new Error("Parent runtime authentication did not provide request authentication");
		}
		let registeredConfig: ReturnType<ModelRegistry["getRegisteredProviderConfig"]>;
		try {
			registeredConfig = modelRegistry.getRegisteredProviderConfig(provider);
		} catch {
			throw new Error("Unable to inspect parent runtime provider configuration");
		}
		const config = serializableProviderConfig(registeredConfig);
		providers.push({
			provider,
			auth: {
				...(resolved.auth.apiKey ? { apiKey: resolved.auth.apiKey } : {}),
				...(resolved.auth.headers ? { headers: { ...resolved.auth.headers } } : {}),
				...(resolved.auth.baseUrl ? { baseUrl: resolved.auth.baseUrl } : {}),
			},
			...(resolved.env ? { env: { ...resolved.env } } : {}),
			...(config ? { config } : {}),
		});
	}
	return parseChildAuthSnapshot({ version: CHILD_AUTH_PROTOCOL, providers });
}

export class ChildAuthProcessHandoff {
	private readonly authInput: Writable;
	private readonly authOutput: Readable;
	private readonly preludeInput: Writable;
	private readonly channel: ParentChildAuthChannel;
	private readonly preludeWritten: Promise<void>;
	private closed = false;

	constructor(proc: Pick<ChildProcess, "stdio">, snapshot: ChildAuthSnapshot) {
		const childStdio = proc.stdio as Array<Readable | Writable | null | undefined>;
		const authInput = childStdio[CHILD_AUTH_READ_FD] as Writable | undefined;
		const authOutput = childStdio[CHILD_AUTH_WRITE_FD] as Readable | undefined;
		const preludeInput = childStdio[CHILD_AUTH_PRELUDE_FD] as Writable | undefined;
		if (!authInput || !authOutput || !preludeInput || typeof authInput.write !== "function") {
			throw new Error("Child authentication pipes were not created");
		}
		this.authInput = authInput;
		this.authOutput = authOutput;
		this.preludeInput = preludeInput;
		this.channel = new ParentChildAuthChannel(authInput, authOutput);
		this.preludeWritten = new Promise<void>((resolve, reject) => {
			const onError = () => reject(new Error("Unable to send child authentication prelude"));
			preludeInput.once("error", onError);
			preludeInput.end(serializeChildAuthPrelude(snapshot), () => {
				preludeInput.off("error", onError);
				resolve();
			});
		});
		void this.preludeWritten.catch(() => undefined);
	}

	async apply(
		snapshot: ChildAuthSnapshot,
		signal?: AbortSignal,
		timeoutMs = DEFAULT_AUTH_ACK_TIMEOUT_MS,
	): Promise<void> {
		if (this.closed) throw new Error("Child authentication handoff is closed");
		const deadline = Date.now() + Math.max(1, timeoutMs);
		await waitForPromise(
			this.preludeWritten,
			signal,
			Math.max(1, deadline - Date.now()),
			"Child authentication prelude",
		);
		await this.channel.send(snapshot, signal, Math.max(1, deadline - Date.now()));
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.channel.close();
		this.authInput.destroy();
		this.authOutput.destroy();
		this.preludeInput.destroy();
	}
}

export class ParentChildAuthChannel {
	private readonly pending = new Map<
		string,
		{
			resolve(): void;
			reject(error: Error): void;
			timer: NodeJS.Timeout;
			abort?: () => void;
		}
	>();
	private buffer = "";
	private nextId = 0;
	private closed = false;
	private disposed = false;

	constructor(
		private readonly input: Writable,
		private readonly output: Readable,
	) {
		output.setEncoding("utf8");
		output.on("data", this.onData);
		output.on("end", this.onClose);
		output.on("close", this.onClose);
		output.on("error", this.onError);
		input.on("error", this.onError);
	}

	async send(
		snapshot: ChildAuthSnapshot,
		signal?: AbortSignal,
		timeoutMs = DEFAULT_AUTH_ACK_TIMEOUT_MS,
	): Promise<void> {
		if (this.closed) throw new Error("Child authentication channel is closed");
		if (signal?.aborted) throw abortError("Child authentication refresh was cancelled");
		const id = `auth-${++this.nextId}`;
		const line = serializeChildAuthRequest({ version: CHILD_AUTH_PROTOCOL, id, snapshot });
		await new Promise<void>((resolve, reject) => {
			const finish = (error?: Error) => {
				const current = this.pending.get(id);
				if (!current) return;
				this.pending.delete(id);
				clearTimeout(current.timer);
				if (signal && current.abort) signal.removeEventListener("abort", current.abort);
				if (error) reject(error);
				else resolve();
			};
			const timer = setTimeout(
				() => finish(new Error("Child authentication acknowledgement timed out")),
				Math.max(1, timeoutMs),
			);
			timer.unref();
			const abort = signal
				? () => finish(abortError("Child authentication refresh was cancelled"))
				: undefined;
			this.pending.set(id, {
				resolve: () => finish(),
				reject: (error) => finish(error),
				timer,
				abort,
			});
			if (signal && abort) signal.addEventListener("abort", abort, { once: true });
			this.input.write(line, (error) => {
				if (error) finish(new Error("Unable to send parent runtime authentication to child"));
			});
		});
	}

	close(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.closed = true;
		this.output.off("data", this.onData);
		this.output.off("end", this.onClose);
		this.output.off("close", this.onClose);
		this.output.off("error", this.onError);
		this.input.off("error", this.onError);
		for (const pending of [...this.pending.values()]) {
			clearTimeout(pending.timer);
			pending.reject(new Error("Child authentication channel closed before acknowledgement"));
		}
		this.pending.clear();
		this.input.once("error", () => undefined);
		this.input.end();
	}

	private readonly onData = (chunk: string | Buffer): void => {
		this.buffer += chunk.toString();
		if (Buffer.byteLength(this.buffer, "utf8") > MAX_CHILD_AUTH_ACK_BYTES) {
			this.fail(new Error("Child authentication acknowledgement exceeded its size limit"));
			return;
		}
		while (true) {
			const index = this.buffer.indexOf("\n");
			if (index < 0) return;
			const line = this.buffer.slice(0, index).trim();
			this.buffer = this.buffer.slice(index + 1);
			if (!line) continue;
			let ack: ChildAuthAck;
			try {
				ack = parseChildAuthAck(JSON.parse(line));
			} catch {
				this.fail(new Error("Child emitted an invalid authentication acknowledgement"));
				return;
			}
			const pending = this.pending.get(ack.id);
			if (!pending) {
				if (!ack.ok) this.fail(new Error("Child rejected parent runtime authentication"));
				continue;
			}
			if (ack.ok) pending.resolve();
			else pending.reject(new Error(ack.error || "Child rejected parent runtime authentication"));
		}
	};

	private readonly onClose = (): void => {
		this.fail(new Error("Child authentication channel closed unexpectedly"));
	};

	private readonly onError = (): void => {
		this.fail(new Error("Child authentication channel failed"));
	};

	private fail(error: Error): void {
		if (this.closed) return;
		this.closed = true;
		for (const pending of [...this.pending.values()]) {
			clearTimeout(pending.timer);
			pending.reject(error);
		}
		this.pending.clear();
	}
}

function serializableProviderConfig(
	config: RegisteredProviderConfig | undefined,
): ProviderConfig | undefined {
	if (!config) return undefined;
	if (config.streamSimple || config.refreshModels || config.oauth) {
		throw new Error(
			"Parent runtime provider requires executable configuration that cannot cross the child process boundary",
		);
	}
	const selected: Record<string, unknown> = {};
	for (const field of SERIALIZABLE_PROVIDER_FIELDS) {
		const value = config[field];
		if (value !== undefined) selected[field] = value;
	}
	if (Object.keys(selected).length === 0) return undefined;
	try {
		const serialized = JSON.stringify(selected, (_key, value: unknown) => {
			const dynamicString =
				typeof value === "string" &&
				(value.trimStart().startsWith("!") || value.trimStart().startsWith("$"));
			if (
				typeof value === "function" ||
				typeof value === "symbol" ||
				typeof value === "bigint" ||
				dynamicString
			) {
				throw new Error("unsupported provider overlay value");
			}
			return value;
		});
		return JSON.parse(serialized) as ProviderConfig;
	} catch {
		throw new Error("Parent runtime provider overlay is not serializable");
	}
}

function waitForPromise(
	promise: Promise<void>,
	signal: AbortSignal | undefined,
	timeoutMs: number,
	label: string,
): Promise<void> {
	return new Promise((resolve, reject) => {
		let settled = false;
		const finish = (error?: unknown) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			if (error) reject(error);
			else resolve();
		};
		const onAbort = () => finish(abortError(`${label} was cancelled`));
		const timer = setTimeout(() => finish(new Error(`${label} timed out`)), Math.max(1, timeoutMs));
		timer.unref();
		signal?.addEventListener("abort", onAbort, { once: true });
		if (signal?.aborted) onAbort();
		promise.then(
			() => finish(),
			(error) => finish(error),
		);
	});
}

function abortError(message: string): Error {
	const error = new Error(message);
	error.name = "AbortError";
	return error;
}
