import { createReadStream, createWriteStream, readFileSync } from "node:fs";
import type { AuthResult, ModelAuth, Provider, ProviderEnv } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
	ProviderConfig,
} from "@earendil-works/pi-coding-agent";
import {
	CHILD_AUTH_PRELUDE_FD,
	CHILD_AUTH_READ_FD,
	CHILD_AUTH_WRITE_FD,
	type ChildAuthProviderSnapshot,
	type ChildAuthSnapshot,
	childAuthAck,
	MAX_CHILD_AUTH_SNAPSHOT_BYTES,
	parseChildAuthPrelude,
	parseChildAuthRequest,
} from "./child-auth-protocol.js";

const PENDING_AUTH_KEY = "pi-subagents-parent-runtime-auth-pending";
const AUTH_FAILURE_MESSAGE = "Inherited parent runtime authentication is unavailable";

interface BootstrapProviderState {
	original?: Provider;
}

export interface ChildAuthBootstrapState {
	providers: Map<string, BootstrapProviderState>;
	activeProviderIds: Set<string>;
	runtimeCredentialProviderIds: Set<string>;
}

export function createChildAuthBootstrapState(): ChildAuthBootstrapState {
	return {
		providers: new Map(),
		activeProviderIds: new Set(),
		runtimeCredentialProviderIds: new Set(),
	};
}

export async function applyChildAuthSnapshot(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	snapshot: ChildAuthSnapshot,
	state: ChildAuthBootstrapState,
): Promise<void> {
	const nextIds = new Set(snapshot.providers.map((entry) => entry.provider));
	const affectedIds = new Set([...state.activeProviderIds, ...nextIds]);
	const removedIds = [...state.activeProviderIds].filter((providerId) => !nextIds.has(providerId));
	try {
		for (const providerId of removedIds) {
			restoreProvider(pi, ctx, providerId, state);
			await removeRuntimeCredentialOverride(ctx, providerId, state);
		}
		for (const entry of snapshot.providers) applyProvider(pi, ctx, entry, state);
		for (const entry of snapshot.providers) {
			try {
				await verifyProviderAuth(ctx, entry);
			} catch {
				await installRuntimeCredentialOverride(ctx, entry.provider, state);
				await verifyProviderAuth(ctx, entry);
			}
		}
		await refreshSelectedModel(pi, ctx, affectedIds);
		for (const providerId of removedIds) {
			state.providers.delete(providerId);
			state.runtimeCredentialProviderIds.delete(providerId);
		}
		state.activeProviderIds = nextIds;
	} catch {
		for (const providerId of affectedIds) {
			installFailClosedProvider(pi, ctx, providerId, state);
		}
		state.activeProviderIds = affectedIds;
		throw new Error(AUTH_FAILURE_MESSAGE);
	}
}

export default function childAuthBootstrap(pi: ExtensionAPI): void {
	const prelude = parseChildAuthPrelude(
		JSON.parse(readFileSync(CHILD_AUTH_PRELUDE_FD, { encoding: "utf8" })),
	);
	for (const entry of prelude.providers) {
		const config = bootstrapProviderConfig(entry.config);
		if (config) pi.registerProvider(entry.provider, config);
	}
	const input = createReadStream("", {
		fd: CHILD_AUTH_READ_FD,
		autoClose: false,
		encoding: "utf8",
	});
	const output = createWriteStream("", { fd: CHILD_AUTH_WRITE_FD, autoClose: false });
	input.on("error", () => undefined);
	output.on("error", () => undefined);
	const state = createChildAuthBootstrapState();
	let activeContext: ExtensionContext | undefined;
	let shuttingDown = false;
	let buffer = "";
	let receivedFirst = false;
	let resolveFirst!: () => void;
	const firstReceived = new Promise<void>((resolve) => {
		resolveFirst = resolve;
	});
	let resolveContext!: (ctx: ExtensionContext) => void;
	let contextReady = new Promise<ExtensionContext>((resolve) => {
		resolveContext = resolve;
	});
	let latestSnapshot: ChildAuthSnapshot | undefined;
	let appliedContext: ExtensionContext | undefined;
	let applyTail = Promise.resolve();

	const writeAck = (id: string, ok: boolean, error?: string) => {
		output.write(`${JSON.stringify(childAuthAck(id, ok, error))}\n`);
	};
	const enqueue = (line: string) => {
		let request: ReturnType<typeof parseChildAuthRequest>;
		try {
			request = parseChildAuthRequest(JSON.parse(line));
		} catch {
			writeAck("invalid", false, "Invalid parent runtime authentication snapshot");
			return;
		}
		if (shuttingDown) {
			writeAck(request.id, false, AUTH_FAILURE_MESSAGE);
			return;
		}
		latestSnapshot = request.snapshot;
		if (!receivedFirst) {
			receivedFirst = true;
			resolveFirst();
		}
		applyTail = applyTail.then(async () => {
			const ctx = activeContext ?? (await contextReady);
			try {
				await applyChildAuthSnapshot(pi, ctx, request.snapshot, state);
				writeAck(request.id, true);
			} catch {
				writeAck(request.id, false, AUTH_FAILURE_MESSAGE);
			} finally {
				appliedContext = ctx;
			}
		});
	};
	input.on("data", (chunk) => {
		buffer += chunk;
		if (Buffer.byteLength(buffer, "utf8") > MAX_CHILD_AUTH_SNAPSHOT_BYTES) {
			buffer = "";
			writeAck("invalid", false, "Parent runtime authentication snapshot is too large");
			return;
		}
		while (true) {
			const index = buffer.indexOf("\n");
			if (index < 0) break;
			const line = buffer.slice(0, index).trim();
			buffer = buffer.slice(index + 1);
			if (line) enqueue(line);
		}
	});

	pi.on("session_start", async (_event, ctx) => {
		shuttingDown = false;
		activeContext = ctx;
		resolveContext(ctx);
		await firstReceived;
		await applyTail;
		if (latestSnapshot && appliedContext !== ctx) {
			await applyChildAuthSnapshot(pi, ctx, latestSnapshot, state).catch(() => undefined);
			appliedContext = ctx;
		}
	});
	pi.on("session_shutdown", async (_event, ctx) => {
		if (activeContext !== ctx) return;
		shuttingDown = true;
		await applyTail;
		if (activeContext !== ctx) return;
		activeContext = undefined;
		appliedContext = undefined;
		state.providers.clear();
		state.activeProviderIds.clear();
		state.runtimeCredentialProviderIds.clear();
		contextReady = new Promise<ExtensionContext>((resolve) => {
			resolveContext = resolve;
		});
	});
}

function applyProvider(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	entry: ChildAuthProviderSnapshot,
	state: ChildAuthBootstrapState,
): void {
	let saved = state.providers.get(entry.provider);
	if (saved) {
		pi.unregisterProvider(entry.provider);
		if (saved.original) pi.registerProvider(saved.original);
	} else {
		pi.unregisterProvider(entry.provider);
		saved = { original: ctx.modelRegistry.getProvider(entry.provider) };
		state.providers.set(entry.provider, saved);
	}
	pi.unregisterProvider(entry.provider);
	const config = bootstrapProviderConfig(entry.config);
	if (config) pi.registerProvider(entry.provider, config);
	const effective = ctx.modelRegistry.getProvider(entry.provider) ?? saved.original;
	if (!effective) throw new Error(AUTH_FAILURE_MESSAGE);
	pi.registerProvider(inheritedAuthProvider(effective, entry.auth, entry.env));
}

// A stored OAuth credential owns Pi's auth resolution even after replacing the provider resolver.
// This non-secret process-local override selects the inherited API-key resolver without persisting auth.
type RuntimeCredentialOverrides = {
	setRuntimeApiKey(providerId: string, apiKey: string): void | Promise<void>;
	removeRuntimeApiKey(providerId: string): void | Promise<void>;
};

async function installRuntimeCredentialOverride(
	ctx: ExtensionContext,
	providerId: string,
	state: ChildAuthBootstrapState,
): Promise<void> {
	const overrides = runtimeCredentialOverrides(ctx);
	if (!overrides) throw new Error(AUTH_FAILURE_MESSAGE);
	state.runtimeCredentialProviderIds.add(providerId);
	await overrides.setRuntimeApiKey(providerId, PENDING_AUTH_KEY);
}

async function removeRuntimeCredentialOverride(
	ctx: ExtensionContext,
	providerId: string,
	state: ChildAuthBootstrapState,
): Promise<void> {
	if (!state.runtimeCredentialProviderIds.has(providerId)) return;
	const overrides = runtimeCredentialOverrides(ctx);
	if (!overrides) throw new Error(AUTH_FAILURE_MESSAGE);
	await overrides.removeRuntimeApiKey(providerId);
}

function runtimeCredentialOverrides(ctx: ExtensionContext): RuntimeCredentialOverrides | undefined {
	const registry = ctx.modelRegistry as unknown as {
		runtime?: unknown;
		authStorage?: unknown;
	};
	for (const candidate of [registry, registry.runtime, registry.authStorage]) {
		if (isRuntimeCredentialOverrides(candidate)) return candidate;
	}
	return undefined;
}

function isRuntimeCredentialOverrides(value: unknown): value is RuntimeCredentialOverrides {
	return (
		!!value &&
		typeof value === "object" &&
		"setRuntimeApiKey" in value &&
		typeof value.setRuntimeApiKey === "function" &&
		"removeRuntimeApiKey" in value &&
		typeof value.removeRuntimeApiKey === "function"
	);
}

function restoreProvider(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	providerId: string,
	state: ChildAuthBootstrapState,
): void {
	const saved = state.providers.get(providerId);
	if (!saved) return;
	const current = ctx.modelRegistry.getProvider(providerId);
	pi.unregisterProvider(providerId);
	if (saved.original) pi.registerProvider(saved.original);
	else if (current) pi.registerProvider(failClosedProvider(current));
}

function installFailClosedProvider(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	providerId: string,
	state: ChildAuthBootstrapState,
): void {
	const provider =
		state.providers.get(providerId)?.original ?? ctx.modelRegistry.getProvider(providerId);
	if (!provider) return;
	pi.unregisterProvider(providerId);
	pi.registerProvider(failClosedProvider(provider));
}

function inheritedAuthProvider(
	provider: Provider,
	auth: ModelAuth,
	env: ProviderEnv | undefined,
): Provider {
	const resolve = async (): Promise<AuthResult> => ({
		auth: cloneAuth(auth),
		...(env ? { env: { ...env } } : {}),
		source: "parent runtime",
	});
	return cloneProvider(provider, {
		apiKey: {
			name: "Inherited parent runtime authentication",
			check: async () => ({ type: "api_key", source: "parent runtime" }),
			resolve,
		},
	});
}

function failClosedProvider(provider: Provider): Provider {
	return cloneProvider(provider, {
		apiKey: {
			name: "Unavailable inherited parent runtime authentication",
			check: async () => {
				throw new Error(AUTH_FAILURE_MESSAGE);
			},
			resolve: async () => {
				throw new Error(AUTH_FAILURE_MESSAGE);
			},
		},
	});
}

function cloneProvider(provider: Provider, auth: Provider["auth"]): Provider {
	return {
		id: provider.id,
		name: provider.name,
		...(provider.baseUrl ? { baseUrl: provider.baseUrl } : {}),
		...(provider.headers ? { headers: { ...provider.headers } } : {}),
		auth,
		getModels: provider.getModels.bind(provider),
		...(provider.refreshModels ? { refreshModels: provider.refreshModels.bind(provider) } : {}),
		...(provider.filterModels ? { filterModels: provider.filterModels.bind(provider) } : {}),
		stream: provider.stream.bind(provider),
		streamSimple: provider.streamSimple.bind(provider),
		...(provider.fetchDeferred ? { fetchDeferred: provider.fetchDeferred.bind(provider) } : {}),
		...(provider.cancelDeferred ? { cancelDeferred: provider.cancelDeferred.bind(provider) } : {}),
	};
}

function bootstrapProviderConfig(
	config: ChildAuthProviderSnapshot["config"],
): ProviderConfig | undefined {
	if (!config) return undefined;
	return { ...config, apiKey: PENDING_AUTH_KEY };
}

async function verifyProviderAuth(
	ctx: ExtensionContext,
	entry: ChildAuthProviderSnapshot,
): Promise<void> {
	const resolved = await ctx.modelRegistry.getProviderAuth(entry.provider);
	if (
		!resolved ||
		(entry.auth.apiKey !== undefined && resolved.auth.apiKey !== entry.auth.apiKey) ||
		(entry.auth.baseUrl !== undefined && resolved.auth.baseUrl !== entry.auth.baseUrl) ||
		!containsHeaders(resolved.auth.headers, entry.auth.headers)
	) {
		throw new Error(AUTH_FAILURE_MESSAGE);
	}
}

function containsHeaders(actual: ModelAuth["headers"], expected: ModelAuth["headers"]): boolean {
	if (!expected) return true;
	return Object.entries(expected).every(([name, value]) => actual?.[name] === value);
}

async function refreshSelectedModel(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	affectedProviderIds: ReadonlySet<string>,
): Promise<void> {
	const selected = ctx.model;
	if (!selected || !affectedProviderIds.has(selected.provider)) return;
	const refreshed = ctx.modelRegistry.find(selected.provider, selected.id);
	if (!refreshed || !(await pi.setModel(refreshed))) throw new Error(AUTH_FAILURE_MESSAGE);
}

function cloneAuth(auth: ModelAuth): ModelAuth {
	return {
		...(auth.apiKey ? { apiKey: auth.apiKey } : {}),
		...(auth.headers ? { headers: { ...auth.headers } } : {}),
		...(auth.baseUrl ? { baseUrl: auth.baseUrl } : {}),
	};
}
