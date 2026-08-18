import type { ModelAuth, ProviderEnv } from "@earendil-works/pi-ai";
import type { ProviderConfig } from "@earendil-works/pi-coding-agent";

export const CHILD_AUTH_PROTOCOL = "pi-subagents:child-auth:v1" as const;
export const CHILD_AUTH_READ_FD = 4;
export const CHILD_AUTH_WRITE_FD = 5;
export const CHILD_AUTH_PRELUDE_FD = 6;
export const MAX_CHILD_AUTH_SNAPSHOT_BYTES = 512 * 1024;
export const MAX_CHILD_AUTH_ACK_BYTES = 16 * 1024;
const MAX_AUTH_PROVIDERS = 64;
const MAX_AUTH_MAP_ENTRIES = 256;
const MAX_AUTH_VALUE_BYTES = 64 * 1024;

type SerializableProviderConfig = Pick<
	ProviderConfig,
	"name" | "baseUrl" | "api" | "headers" | "authHeader" | "models"
>;

export interface ChildAuthProviderSnapshot {
	provider: string;
	auth: ModelAuth;
	env?: ProviderEnv;
	config?: SerializableProviderConfig;
}

export interface ChildAuthSnapshot {
	version: typeof CHILD_AUTH_PROTOCOL;
	providers: ChildAuthProviderSnapshot[];
}

export interface ChildAuthRequest {
	version: typeof CHILD_AUTH_PROTOCOL;
	id: string;
	snapshot: ChildAuthSnapshot;
}

export interface ChildAuthPrelude {
	version: typeof CHILD_AUTH_PROTOCOL;
	providers: Array<Pick<ChildAuthProviderSnapshot, "provider" | "config">>;
}

export interface ChildAuthAck {
	version: typeof CHILD_AUTH_PROTOCOL;
	id: string;
	ok: boolean;
	error?: string;
}

export function serializeChildAuthRequest(request: ChildAuthRequest): string {
	const normalized = parseChildAuthRequest(request);
	const serialized = JSON.stringify(normalized);
	if (Buffer.byteLength(serialized, "utf8") > MAX_CHILD_AUTH_SNAPSHOT_BYTES) {
		throw new Error("Parent runtime authentication snapshot exceeds its size limit");
	}
	return `${serialized}\n`;
}

export function serializeChildAuthPrelude(snapshot: ChildAuthSnapshot): string {
	const normalized = parseChildAuthSnapshot(snapshot);
	const serialized = JSON.stringify({
		version: CHILD_AUTH_PROTOCOL,
		providers: normalized.providers.map(({ provider, config }) => ({
			provider,
			...(config ? { config } : {}),
		})),
	});
	if (Buffer.byteLength(serialized, "utf8") > MAX_CHILD_AUTH_SNAPSHOT_BYTES) {
		throw new Error("Child authentication provider prelude exceeds its size limit");
	}
	return serialized;
}

export function parseChildAuthPrelude(value: unknown): ChildAuthPrelude {
	if (
		!isRecord(value) ||
		value.version !== CHILD_AUTH_PROTOCOL ||
		!Array.isArray(value.providers)
	) {
		throw new Error("Invalid child authentication provider prelude");
	}
	if (value.providers.length > MAX_AUTH_PROVIDERS) {
		throw new Error("Invalid child authentication provider prelude");
	}
	const seen = new Set<string>();
	return {
		version: CHILD_AUTH_PROTOCOL,
		providers: value.providers.map((entry, index) => {
			if (!isRecord(entry)) throw new Error(`Invalid provider prelude ${index + 1}`);
			const provider = boundedString(entry.provider, `provider ${index + 1} id`, 256);
			if (seen.has(provider)) throw new Error("Duplicate child authentication provider prelude");
			seen.add(provider);
			return {
				provider,
				...(entry.config === undefined
					? {}
					: { config: parseSerializableProviderConfig(entry.config, index) }),
			};
		}),
	};
}

export function parseChildAuthRequest(value: unknown): ChildAuthRequest {
	if (!isRecord(value) || value.version !== CHILD_AUTH_PROTOCOL) {
		throw new Error("Invalid child authentication protocol version");
	}
	const id = boundedString(value.id, "request id", 128);
	return {
		version: CHILD_AUTH_PROTOCOL,
		id,
		snapshot: parseChildAuthSnapshot(value.snapshot),
	};
}

export function parseChildAuthSnapshot(value: unknown): ChildAuthSnapshot {
	if (!isRecord(value) || value.version !== CHILD_AUTH_PROTOCOL) {
		throw new Error("Invalid parent runtime authentication snapshot");
	}
	if (!Array.isArray(value.providers) || value.providers.length > MAX_AUTH_PROVIDERS) {
		throw new Error("Invalid parent runtime authentication provider list");
	}
	const seen = new Set<string>();
	const providers = value.providers.map((entry, index) => {
		if (!isRecord(entry)) throw new Error(`Invalid authentication provider entry ${index + 1}`);
		const provider = boundedString(entry.provider, `provider ${index + 1} id`, 256);
		if (seen.has(provider)) throw new Error("Duplicate parent runtime authentication provider");
		seen.add(provider);
		return {
			provider,
			auth: parseModelAuth(entry.auth, index),
			...(entry.env === undefined ? {} : { env: parseStringMap(entry.env, "environment") }),
			...(entry.config === undefined
				? {}
				: { config: parseSerializableProviderConfig(entry.config, index) }),
		};
	});
	return { version: CHILD_AUTH_PROTOCOL, providers };
}

export function parseChildAuthAck(value: unknown): ChildAuthAck {
	if (!isRecord(value) || value.version !== CHILD_AUTH_PROTOCOL) {
		throw new Error("Invalid child authentication acknowledgement");
	}
	const id = boundedString(value.id, "acknowledgement id", 128);
	if (typeof value.ok !== "boolean") {
		throw new Error("Invalid child authentication acknowledgement status");
	}
	const error =
		value.error === undefined
			? undefined
			: boundedString(value.error, "acknowledgement error", 2 * 1024);
	return { version: CHILD_AUTH_PROTOCOL, id, ok: value.ok, ...(error ? { error } : {}) };
}

export function childAuthAck(id: string, ok: boolean, error?: string): ChildAuthAck {
	return {
		version: CHILD_AUTH_PROTOCOL,
		id: boundedString(id, "acknowledgement id", 128),
		ok,
		...(error ? { error: truncateUtf8(error, 2 * 1024) } : {}),
	};
}

function parseModelAuth(value: unknown, index: number): ModelAuth {
	if (!isRecord(value)) throw new Error(`Invalid authentication payload ${index + 1}`);
	const apiKey = optionalBoundedString(value.apiKey, "API key", MAX_AUTH_VALUE_BYTES);
	const baseUrl = optionalBoundedString(value.baseUrl, "base URL", MAX_AUTH_VALUE_BYTES);
	const headers =
		value.headers === undefined
			? undefined
			: parseHeaderMap(value.headers, "authentication headers");
	if (!apiKey && !baseUrl && (!headers || Object.keys(headers).length === 0)) {
		throw new Error(`Parent runtime authentication provider ${index + 1} has no request auth`);
	}
	return {
		...(apiKey ? { apiKey } : {}),
		...(headers ? { headers } : {}),
		...(baseUrl ? { baseUrl } : {}),
	};
}

function parseSerializableProviderConfig(
	value: unknown,
	index: number,
): SerializableProviderConfig {
	if (!isRecord(value)) throw new Error(`Invalid provider overlay ${index + 1}`);
	const allowed = new Set(["name", "baseUrl", "api", "headers", "authHeader", "models"]);
	for (const key of Object.keys(value)) {
		if (!allowed.has(key)) throw new Error(`Unsupported provider overlay field ${key}`);
	}
	const name = optionalBoundedString(value.name, "provider name", 1024);
	const baseUrl = optionalBoundedString(value.baseUrl, "provider base URL", MAX_AUTH_VALUE_BYTES);
	const api = optionalBoundedString(value.api, "provider API", 256) as ProviderConfig["api"];
	if (value.authHeader !== undefined && typeof value.authHeader !== "boolean") {
		throw new Error("Invalid provider authHeader overlay");
	}
	const headers =
		value.headers === undefined ? undefined : parseStringMap(value.headers, "provider headers");
	let models: ProviderConfig["models"];
	if (value.models !== undefined) {
		if (!Array.isArray(value.models)) throw new Error("Invalid provider models overlay");
		const serialized = JSON.stringify(value.models);
		if (Buffer.byteLength(serialized, "utf8") > MAX_CHILD_AUTH_SNAPSHOT_BYTES) {
			throw new Error("Provider models overlay exceeds its size limit");
		}
		models = JSON.parse(serialized) as ProviderConfig["models"];
	}
	return {
		...(name ? { name } : {}),
		...(baseUrl ? { baseUrl } : {}),
		...(api ? { api } : {}),
		...(headers ? { headers } : {}),
		...(value.authHeader === undefined ? {} : { authHeader: value.authHeader }),
		...(models ? { models } : {}),
	};
}

function parseHeaderMap(value: unknown, label: string): Record<string, string | null> {
	if (!isRecord(value) || Object.keys(value).length > MAX_AUTH_MAP_ENTRIES) {
		throw new Error(`Invalid ${label}`);
	}
	const result: Record<string, string | null> = {};
	for (const [key, item] of Object.entries(value)) {
		if (!key || Buffer.byteLength(key, "utf8") > 1024) throw new Error(`Invalid ${label} name`);
		if (item !== null && typeof item !== "string") throw new Error(`Invalid ${label} value`);
		if (typeof item === "string" && Buffer.byteLength(item, "utf8") > MAX_AUTH_VALUE_BYTES) {
			throw new Error(`${label} value exceeds its size limit`);
		}
		result[key] = item;
	}
	return result;
}

function parseStringMap(value: unknown, label: string): Record<string, string> {
	if (!isRecord(value) || Object.keys(value).length > MAX_AUTH_MAP_ENTRIES) {
		throw new Error(`Invalid ${label}`);
	}
	const result: Record<string, string> = {};
	for (const [key, item] of Object.entries(value)) {
		if (!key || Buffer.byteLength(key, "utf8") > 1024) throw new Error(`Invalid ${label} name`);
		if (typeof item !== "string") throw new Error(`Invalid ${label} value`);
		if (Buffer.byteLength(item, "utf8") > MAX_AUTH_VALUE_BYTES) {
			throw new Error(`${label} value exceeds its size limit`);
		}
		result[key] = item;
	}
	return result;
}

function boundedString(value: unknown, label: string, maxBytes: number): string {
	if (typeof value !== "string" || !value || Buffer.byteLength(value, "utf8") > maxBytes) {
		throw new Error(`Invalid child authentication ${label}`);
	}
	return value;
}

function optionalBoundedString(
	value: unknown,
	label: string,
	maxBytes: number,
): string | undefined {
	if (value === undefined) return undefined;
	return boundedString(value, label, maxBytes);
}

function truncateUtf8(value: string, maxBytes: number): string {
	if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
	let end = value.length;
	while (end > 0 && Buffer.byteLength(value.slice(0, end), "utf8") > maxBytes) end--;
	return value.slice(0, end);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}
