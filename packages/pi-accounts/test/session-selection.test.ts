import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type SessionEntry, SessionManager } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import {
	ACCOUNT_SELECTION_ENTRY_TYPE,
	cloneAccountSelections,
	createAccountSelectionEntryData,
	loadNewestProjectAccountSelections,
	restoreAccountSelections,
	setAccountSelection,
	shouldLoadRecentAccountSelections,
} from "../src/session-selection.js";

function customEntry(data: unknown, id = randomUUID().slice(0, 8)): SessionEntry {
	return {
		type: "custom",
		id,
		parentId: null,
		timestamp: new Date().toISOString(),
		customType: ACCOUNT_SELECTION_ENTRY_TYPE,
		data,
	};
}

function persistSession(manager: SessionManager): void {
	manager.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "ready" }],
		api: "openai-responses",
		provider: "openai-codex",
		model: "codex",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	});
}

test("session account selections restore the latest matching session snapshot", () => {
	const entries = [
		customEntry(
			createAccountSelectionEntryData("other-session", { anthropic: "other" }),
			"other000",
		),
		customEntry(
			createAccountSelectionEntryData("current-session", {
				anthropic: "work",
				"openai-codex": null,
			}),
			"current1",
		),
		customEntry(
			createAccountSelectionEntryData("current-session", {
				anthropic: "personal",
				"openai-codex": null,
			}),
			"current2",
		),
	];

	const restored = restoreAccountSelections(entries, "current-session");
	assert.equal(restored.status, "loaded");
	if (restored.status === "loaded") {
		assert.deepEqual(
			{ ...restored.selections },
			{
				anthropic: "personal",
				"openai-codex": null,
			},
		);
	}
	assert.deepEqual(restoreAccountSelections(entries, "missing-session"), { status: "missing" });
});

test("session account selections preserve valid unknown providers and own properties", () => {
	const source = JSON.parse('{"anthropic":"work","future.provider":"next"}') as Record<
		string,
		string
	>;
	const data = createAccountSelectionEntryData("session", source);
	const updated = setAccountSelection(data.providers, "anthropic", null);
	const cloned = cloneAccountSelections(updated);

	assert.equal(Object.getPrototypeOf(cloned), null);
	assert.equal(cloned.anthropic, null);
	assert.equal(cloned["future.provider"], "next");
	assert.throws(
		() =>
			createAccountSelectionEntryData(
				"session",
				JSON.parse('{"__proto__":"guarded"}') as Record<string, string>,
			),
		/invalid account selection provider/iu,
	);
});

test("session account selections reject malformed matching snapshots without using older state", () => {
	const valid = customEntry(
		createAccountSelectionEntryData("session", { anthropic: "work" }),
		"valid000",
	);
	const malformed = customEntry(
		{ version: 2, sessionId: "session", providers: { anthropic: "personal" } },
		"invalid0",
	);
	const restored = restoreAccountSelections([valid, malformed], "session");

	assert.equal(restored.status, "invalid");
	if (restored.status === "invalid") {
		assert.match(restored.message, /invalid.*\/accounts/iu);
	}
});

test("session account selections ignore copied snapshots owned by another session", () => {
	const copied = customEntry(
		createAccountSelectionEntryData("parent-session", { anthropic: "parent" }),
	);

	assert.deepEqual(restoreAccountSelections([copied], "child-session"), { status: "missing" });
});

test("recent account selection loading is limited to the newest usable project session", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-accounts-recent-selection-"));
	const project = join(root, "project");
	const otherProject = join(root, "other-project");
	const sessionDir = join(root, "sessions");
	try {
		const sourceId = randomUUID();
		const source = SessionManager.create(project, sessionDir, { id: sourceId });
		source.appendCustomEntry(
			ACCOUNT_SELECTION_ENTRY_TYPE,
			createAccountSelectionEntryData(sourceId, {
				anthropic: "work",
				"future.provider": null,
			}),
		);
		persistSession(source);
		const sourceFile = source.getSessionFile();
		assert.ok(sourceFile);

		const invalidId = randomUUID();
		const invalid = SessionManager.create(project, sessionDir, { id: invalidId });
		invalid.appendCustomEntry(ACCOUNT_SELECTION_ENTRY_TYPE, {
			version: 2,
			sessionId: invalidId,
			providers: { anthropic: "invalid" },
		});
		persistSession(invalid);
		const invalidFile = invalid.getSessionFile();
		assert.ok(invalidFile);

		const unrelatedId = randomUUID();
		const unrelated = SessionManager.create(otherProject, sessionDir, { id: unrelatedId });
		unrelated.appendCustomEntry(
			ACCOUNT_SELECTION_ENTRY_TYPE,
			createAccountSelectionEntryData(unrelatedId, { anthropic: "other" }),
		);
		persistSession(unrelated);
		const unrelatedFile = unrelated.getSessionFile();
		assert.ok(unrelatedFile);

		const now = Date.now() / 1_000;
		await utimes(sourceFile, now - 30, now - 30);
		await utimes(invalidFile, now - 20, now - 20);
		await utimes(unrelatedFile, now - 10, now - 10);

		const currentId = randomUUID();
		const current = SessionManager.create(project, sessionDir, { id: currentId });
		current.appendCustomEntry(
			ACCOUNT_SELECTION_ENTRY_TYPE,
			createAccountSelectionEntryData(currentId, { anthropic: "current" }),
		);
		persistSession(current);
		const loaded = await loadNewestProjectAccountSelections({
			cwd: project,
			sessionManager: current,
		});
		assert.equal(loaded.status, "loaded");
		if (loaded.status === "loaded") {
			assert.deepEqual({ ...loaded.selections }, { anthropic: "work", "future.provider": null });
		}
	} finally {
		await rm(root, { force: true, recursive: true });
	}
});

test("recent account selection loading reports invalid state when no candidate is usable", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-accounts-invalid-recent-selection-"));
	const project = join(root, "project");
	const sessionDir = join(root, "sessions");
	try {
		const invalidId = randomUUID();
		const invalid = SessionManager.create(project, sessionDir, { id: invalidId });
		invalid.appendCustomEntry(ACCOUNT_SELECTION_ENTRY_TYPE, {
			version: 2,
			sessionId: invalidId,
			providers: { anthropic: "invalid" },
		});
		persistSession(invalid);

		const current = SessionManager.create(project, sessionDir, { id: randomUUID() });
		const loaded = await loadNewestProjectAccountSelections({
			cwd: project,
			sessionManager: current,
		});
		assert.equal(loaded.status, "invalid");
	} finally {
		await rm(root, { force: true, recursive: true });
	}
});

test("recent selection loading runs only for genuinely new session starts", () => {
	assert.equal(shouldLoadRecentAccountSelections("new", "/existing/session.jsonl"), true);
	assert.equal(shouldLoadRecentAccountSelections("startup", undefined), true);
	assert.equal(shouldLoadRecentAccountSelections("resume", undefined), false);
	assert.equal(shouldLoadRecentAccountSelections("switch", undefined), false);
});

test("recent selection loading honors lifecycle cancellation", async () => {
	const controller = new AbortController();
	controller.abort(new DOMException("Session replaced", "AbortError"));
	await assert.rejects(
		loadNewestProjectAccountSelections(
			{
				cwd: process.cwd(),
				sessionManager: SessionManager.inMemory(process.cwd()),
			},
			controller.signal,
		),
		(error: Error) => error.name === "AbortError",
	);
});

test("session account selections survive reopen while copied forks initialize independently", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-accounts-session-selection-"));
	try {
		const sourceId = randomUUID();
		const source = SessionManager.create(root, join(root, "source"), { id: sourceId });
		source.appendCustomEntry(
			ACCOUNT_SELECTION_ENTRY_TYPE,
			createAccountSelectionEntryData(sourceId, { anthropic: "work" }),
		);
		source.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "ready" }],
			api: "openai-responses",
			provider: "openai-codex",
			model: "codex",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		});
		const sourceFile = source.getSessionFile();
		assert.ok(sourceFile);

		const reopened = SessionManager.open(sourceFile);
		const restoredSource = restoreAccountSelections(reopened.getEntries(), sourceId);
		assert.equal(restoredSource.status, "loaded");
		if (restoredSource.status === "loaded") {
			assert.deepEqual({ ...restoredSource.selections }, { anthropic: "work" });
		}

		const childId = randomUUID();
		const child = SessionManager.forkFrom(sourceFile, root, join(root, "child"), { id: childId });
		assert.deepEqual(restoreAccountSelections(child.getEntries(), childId), { status: "missing" });
		child.appendCustomEntry(
			ACCOUNT_SELECTION_ENTRY_TYPE,
			createAccountSelectionEntryData(childId, { anthropic: "personal" }),
		);
		const childFile = child.getSessionFile();
		assert.ok(childFile);
		const restoredChild = restoreAccountSelections(
			SessionManager.open(childFile).getEntries(),
			childId,
		);
		assert.equal(restoredChild.status, "loaded");
		if (restoredChild.status === "loaded") {
			assert.deepEqual({ ...restoredChild.selections }, { anthropic: "personal" });
		}
	} finally {
		await rm(root, { force: true, recursive: true });
	}
});
