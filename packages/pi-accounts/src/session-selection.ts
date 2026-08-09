import { createReadStream, type Dirent, existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import {
	type ExtensionContext,
	migrateSessionEntries,
	parseSessionEntries,
	type SessionEntry,
	type SessionHeader,
} from "@earendil-works/pi-coding-agent";
import { defineOwn, defineOwnMap, parseAccountName } from "./account-store.js";

export const ACCOUNT_SELECTION_ENTRY_TYPE = "pi-accounts-selection";
const ACCOUNT_SELECTION_VERSION = 1;
const PROVIDER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const MAX_PROVIDER_SELECTIONS = 1_000;
const MAX_RECENT_SESSION_METADATA_CANDIDATES = 2_048;
const MAX_RECENT_SESSION_STATE_READS = 32;
const MAX_RECENT_SESSION_FILE_BYTES = 16 * 1024 * 1024;
const MAX_RECENT_SESSION_TOTAL_BYTES = 32 * 1024 * 1024;
const SESSION_STAT_CONCURRENCY = 16;

export type ProviderAccountSelections = Record<string, string | null>;

export type AccountSelectionEntryData = {
	version: 1;
	sessionId: string;
	providers: ProviderAccountSelections;
};

export type RestoredAccountSelections =
	| { status: "missing" }
	| { status: "loaded"; selections: ProviderAccountSelections }
	| { status: "invalid"; message: string };

type RecentSessionContext = Pick<ExtensionContext, "cwd" | "sessionManager">;

type SessionCandidate = {
	path: string;
	modified: number;
	size: number;
};

export function restoreAccountSelections(
	entries: readonly SessionEntry[],
	sessionId: string,
): RestoredAccountSelections {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (entry?.type !== "custom" || entry.customType !== ACCOUNT_SELECTION_ENTRY_TYPE) continue;
		if (!isRecord(entry.data) || entry.data.sessionId !== sessionId) continue;
		try {
			return { status: "loaded", selections: parseSelectionEntryData(entry.data).providers };
		} catch {
			return {
				status: "invalid",
				message:
					"The saved account selection for this Pi session is invalid. Choose an account or default from /accounts to recover.",
			};
		}
	}
	return { status: "missing" };
}

export function shouldLoadRecentAccountSelections(
	reason: string,
	currentSessionFile: string | undefined,
): boolean {
	return (
		reason === "new" ||
		(reason === "startup" && (!currentSessionFile || !existsSync(currentSessionFile)))
	);
}

export async function loadNewestProjectAccountSelections(
	ctx: RecentSessionContext,
	signal = new AbortController().signal,
): Promise<RestoredAccountSelections> {
	signal.throwIfAborted();
	const sessionDir = ctx.sessionManager.getSessionDir();
	if (!sessionDir) return { status: "missing" };
	const currentSessionFile = ctx.sessionManager.getSessionFile();
	const currentPath = currentSessionFile ? resolve(currentSessionFile) : undefined;
	const currentCwd = resolve(ctx.sessionManager.getCwd() || ctx.cwd);
	let entries: Dirent[];
	try {
		entries = await readdir(sessionDir, { withFileTypes: true });
	} catch {
		return { status: "missing" };
	}
	const candidates = await recentSessionCandidates(entries, sessionDir, currentPath, signal);
	let invalid: Extract<RestoredAccountSelections, { status: "invalid" }> | undefined;
	let stateReads = 0;
	let totalReadBudget = 0;
	for (const candidate of candidates) {
		signal.throwIfAborted();
		if (stateReads >= MAX_RECENT_SESSION_STATE_READS) break;
		if (candidate.size > MAX_RECENT_SESSION_FILE_BYTES) continue;
		const candidateReadBudget = candidate.size * 2;
		if (totalReadBudget + candidateReadBudget > MAX_RECENT_SESSION_TOTAL_BYTES) continue;
		stateReads += 1;
		totalReadBudget += candidateReadBudget;
		try {
			if (!(await containsAccountSelectionEntry(candidate.path, candidate.size, signal))) continue;
			const loaded = await loadAccountSelectionsFromFile(candidate, currentCwd, signal);
			if (loaded.status === "loaded") return loaded;
			if (loaded.status === "invalid") invalid ??= loaded;
		} catch {
			if (signal.aborted) throw signal.reason;
			// A concurrently written or damaged session cannot provide inheritance state.
		}
	}
	return invalid ?? { status: "missing" };
}

async function recentSessionCandidates(
	entries: Dirent[],
	sessionDir: string,
	currentPath: string | undefined,
	signal: AbortSignal,
): Promise<SessionCandidate[]> {
	const paths = entries
		.filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
		.filter((entry) => resolve(sessionDir, entry.name) !== currentPath)
		.sort((left, right) => right.name.localeCompare(left.name))
		.slice(0, MAX_RECENT_SESSION_METADATA_CANDIDATES)
		.map((entry) => resolve(sessionDir, entry.name));
	const candidates: SessionCandidate[] = [];
	for (let offset = 0; offset < paths.length; offset += SESSION_STAT_CONCURRENCY) {
		signal.throwIfAborted();
		const batch = await Promise.all(
			paths.slice(offset, offset + SESSION_STAT_CONCURRENCY).map(async (path) => {
				try {
					const metadata = await stat(path);
					return metadata.size > 0
						? { path, modified: metadata.mtimeMs, size: metadata.size }
						: undefined;
				} catch {
					return undefined;
				}
			}),
		);
		for (const candidate of batch) {
			if (candidate) candidates.push(candidate);
		}
	}
	candidates.sort(
		(left, right) => right.modified - left.modified || right.path.localeCompare(left.path),
	);
	return candidates;
}

async function containsAccountSelectionEntry(
	path: string,
	expectedSize: number,
	signal: AbortSignal,
): Promise<boolean> {
	const marker = `"${ACCOUNT_SELECTION_ENTRY_TYPE}"`;
	let bytesRead = 0;
	let suffix = "";
	for await (const chunk of createReadStream(path, { encoding: "utf8", signal })) {
		signal.throwIfAborted();
		bytesRead += Buffer.byteLength(chunk);
		if (bytesRead > expectedSize || bytesRead > MAX_RECENT_SESSION_FILE_BYTES) {
			throw new Error("Recent session changed or exceeded its read bound.");
		}
		const text = suffix + chunk;
		if (text.includes(marker)) return true;
		suffix = text.slice(-marker.length);
	}
	return false;
}

async function loadAccountSelectionsFromFile(
	candidate: SessionCandidate,
	currentCwd: string,
	signal: AbortSignal,
): Promise<RestoredAccountSelections> {
	const content = await readFile(candidate.path, { encoding: "utf8", signal });
	signal.throwIfAborted();
	const contentBytes = Buffer.byteLength(content);
	if (contentBytes > candidate.size || contentBytes > MAX_RECENT_SESSION_FILE_BYTES) {
		throw new Error("Recent session changed or exceeded its read bound.");
	}
	const metadata = await stat(candidate.path);
	if (metadata.size !== candidate.size || metadata.mtimeMs !== candidate.modified) {
		throw new Error("Recent session changed while its account state was read.");
	}
	const entries = parseSessionEntries(content);
	migrateSessionEntries(entries);
	signal.throwIfAborted();
	const header = entries.find((entry): entry is SessionHeader => entry.type === "session");
	if (!header?.cwd || resolve(header.cwd) !== currentCwd) return { status: "missing" };
	const sessionEntries = entries.filter((entry): entry is SessionEntry => entry.type !== "session");
	return restoreAccountSelections(sessionEntries, header.id);
}

export function createAccountSelectionEntryData(
	sessionId: string,
	selections: ProviderAccountSelections,
): AccountSelectionEntryData {
	if (!sessionId) throw new Error("Cannot persist account selection without a Pi session ID.");
	return {
		version: ACCOUNT_SELECTION_VERSION,
		sessionId,
		providers: normalizeSelections(selections),
	};
}

export function setAccountSelection(
	selections: ProviderAccountSelections,
	providerId: string,
	accountName: string | null,
): ProviderAccountSelections {
	return defineOwn(selections, providerId, accountName);
}

export function cloneAccountSelections(
	selections: ProviderAccountSelections,
): ProviderAccountSelections {
	return defineOwnMap(selections);
}

function parseSelectionEntryData(value: Record<string, unknown>): AccountSelectionEntryData {
	if (value.version !== ACCOUNT_SELECTION_VERSION) {
		throw new Error("Unsupported account selection version.");
	}
	if (typeof value.sessionId !== "string" || !value.sessionId) {
		throw new Error("Invalid account selection session ID.");
	}
	if (!isRecord(value.providers)) throw new Error("Invalid account selections.");
	return {
		version: ACCOUNT_SELECTION_VERSION,
		sessionId: value.sessionId,
		providers: normalizeSelections(value.providers),
	};
}

function normalizeSelections(value: Record<string, unknown>): ProviderAccountSelections {
	const entries = Object.entries(value);
	if (entries.length > MAX_PROVIDER_SELECTIONS) throw new Error("Too many account selections.");
	const selections = Object.create(null) as ProviderAccountSelections;
	for (const [providerId, accountName] of entries) {
		if (!PROVIDER_ID_RE.test(providerId)) throw new Error("Invalid account selection provider.");
		if (accountName === null) {
			Object.defineProperty(selections, providerId, {
				configurable: true,
				enumerable: true,
				value: null,
				writable: true,
			});
			continue;
		}
		if (typeof accountName !== "string") throw new Error("Invalid selected account.");
		const parsed = parseAccountName(accountName);
		if (!parsed.ok) throw new Error("Invalid selected account.");
		Object.defineProperty(selections, providerId, {
			configurable: true,
			enumerable: true,
			value: parsed.name,
			writable: true,
		});
	}
	return selections;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
