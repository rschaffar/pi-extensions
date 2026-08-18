import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import { createChildAuthSnapshot, ParentChildAuthChannel } from "../src/child-auth.js";
import {
	applyChildAuthSnapshot,
	createChildAuthBootstrapState,
} from "../src/child-auth-bootstrap.js";
import {
	CHILD_AUTH_PROTOCOL,
	type ChildAuthSnapshot,
	childAuthAck,
	parseChildAuthRequest,
} from "../src/child-auth-protocol.js";
import { runChild } from "../src/process.js";

async function runtimeWithAuth(root: string, key: string): Promise<ModelRuntime> {
	mkdirSync(root, { recursive: true });
	const authPath = path.join(root, "auth.json");
	writeFileSync(authPath, `${JSON.stringify({ anthropic: { type: "api_key", key } })}\n`, {
		mode: 0o600,
	});
	return ModelRuntime.create({ authPath, modelsPath: null });
}

function fakeCodexAccessToken(accountId: string): string {
	return [
		Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url"),
		Buffer.from(
			JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } }),
		).toString("base64url"),
		"signature",
	].join(".");
}

test("child auth snapshots include selected runtime overrides and omit stored credentials", async () => {
	const root = mkdtempSync(path.join(os.tmpdir(), "pi-subagents-child-auth-snapshot-"));
	try {
		const runtime = await runtimeWithAuth(root, "stored-parent-key");
		const registry = new ModelRegistry(runtime);
		assert.deepEqual((await createChildAuthSnapshot(registry, ["anthropic"])).providers, []);

		await runtime.setRuntimeApiKey("anthropic", "selected-parent-key");
		const snapshot = await createChildAuthSnapshot(registry, ["anthropic"]);
		assert.equal(snapshot.providers.length, 1);
		assert.equal(snapshot.providers[0]?.provider, "anthropic");
		assert.equal(snapshot.providers[0]?.auth.apiKey, "selected-parent-key");
		assert.equal(JSON.stringify(snapshot).includes("stored-parent-key"), false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("child auth snapshots reject executable provider overlays instead of degrading them", async () => {
	const root = mkdtempSync(path.join(os.tmpdir(), "pi-subagents-child-auth-function-"));
	try {
		const runtime = await ModelRuntime.create({
			authPath: path.join(root, "auth.json"),
			modelsPath: null,
		});
		runtime.registerProvider("function-provider", {
			api: "openai-completions",
			apiKey: "fallback",
			baseUrl: "http://127.0.0.1/unused",
			streamSimple: () => {
				throw new Error("must not execute");
			},
			models: [
				{
					id: "model",
					name: "Model",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 8_192,
					maxTokens: 1_024,
				},
			],
		});
		await runtime.setRuntimeApiKey("function-provider", "runtime-key");
		await assert.rejects(
			() => createChildAuthSnapshot(new ModelRegistry(runtime), ["function-provider"]),
			/executable configuration.*cannot cross/i,
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("child auth snapshots reject dynamic model headers", async () => {
	const root = mkdtempSync(path.join(os.tmpdir(), "pi-subagents-child-auth-command-"));
	try {
		const runtime = await ModelRuntime.create({
			authPath: path.join(root, "auth.json"),
			modelsPath: null,
		});
		for (const [index, header] of [
			"!secret-manager read model-key",
			"$MODEL_AUTHORIZATION",
		].entries()) {
			const provider = `dynamic-provider-${index}`;
			runtime.registerProvider(provider, {
				api: "openai-completions",
				apiKey: "fallback",
				baseUrl: "http://127.0.0.1/unused",
				models: [
					{
						id: "model",
						name: "Model",
						reasoning: false,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 8_192,
						maxTokens: 1_024,
						headers: { Authorization: header },
					},
				],
			});
			await runtime.setRuntimeApiKey(provider, "runtime-key");
			await assert.rejects(
				() => createChildAuthSnapshot(new ModelRegistry(runtime), [provider]),
				/provider overlay is not serializable/i,
			);
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("child auth snapshots reject native executable providers", async () => {
	const root = mkdtempSync(path.join(os.tmpdir(), "pi-subagents-child-auth-native-"));
	try {
		const runtime = await runtimeWithAuth(root, "stored-parent-key");
		const registry = new ModelRegistry(runtime);
		const provider = registry.getProvider("anthropic");
		assert.ok(provider);
		runtime.registerNativeProvider(provider);
		await runtime.setRuntimeApiKey("anthropic", "runtime-key");
		await assert.rejects(
			() => createChildAuthSnapshot(registry, ["anthropic"]),
			/executable native configuration.*cannot cross/i,
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("child auth bootstrap applies pi-accounts-style provider overlays", async () => {
	const root = mkdtempSync(path.join(os.tmpdir(), "pi-subagents-child-auth-codex-"));
	try {
		const parentRuntime = await ModelRuntime.create({
			authPath: path.join(root, "parent-auth.json"),
			modelsPath: null,
		});
		parentRuntime.registerProvider("openai-codex", {
			apiKey: "pi-accounts-auth-bridge",
			baseUrl: "https://selected.example.test/codex",
			headers: { "x-selected-account": "parent" },
		});
		await parentRuntime.setRuntimeApiKey("openai-codex", "selected-codex-key");
		const snapshot = await createChildAuthSnapshot(new ModelRegistry(parentRuntime), [
			"openai-codex",
		]);
		assert.deepEqual(snapshot.providers[0]?.auth, {
			apiKey: "selected-codex-key",
			headers: { "x-selected-account": "parent" },
		});
		assert.equal(snapshot.providers[0]?.config?.baseUrl, "https://selected.example.test/codex");

		const childRuntime = await ModelRuntime.create({
			authPath: path.join(root, "child-auth.json"),
			modelsPath: null,
		});
		const childRegistry = new ModelRegistry(childRuntime);
		const pi = {
			registerProvider(providerOrName: unknown, config?: unknown) {
				if (typeof providerOrName === "string") {
					childRuntime.registerProvider(providerOrName, config as never);
				} else {
					childRuntime.registerNativeProvider(providerOrName as never);
				}
			},
			unregisterProvider(provider: string) {
				childRuntime.unregisterProvider(provider);
			},
		};
		const state = createChildAuthBootstrapState();
		await applyChildAuthSnapshot(
			pi as never,
			{ modelRegistry: childRegistry } as never,
			snapshot,
			state,
		);
		assert.equal(state.runtimeCredentialProviderIds.size, 0);
		assert.deepEqual((await childRegistry.getProviderAuth("openai-codex"))?.auth, {
			apiKey: "selected-codex-key",
			headers: { "x-selected-account": "parent" },
		});
		assert.equal(
			childRegistry.getProvider("openai-codex")?.baseUrl,
			"https://selected.example.test/codex",
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("child runtime auth supersedes and restores a stored OAuth credential", async () => {
	const root = mkdtempSync(path.join(os.tmpdir(), "pi-subagents-child-auth-oauth-"));
	try {
		const storedAccess = fakeCodexAccessToken("stored-account");
		const authPath = path.join(root, "child-auth.json");
		const storedAuth = `${JSON.stringify({
			"openai-codex": {
				type: "oauth",
				access: storedAccess,
				refresh: "stored-refresh",
				expires: Date.now() + 60 * 60 * 1000,
				accountId: "stored-account",
			},
		})}\n`;
		writeFileSync(authPath, storedAuth, { mode: 0o600 });
		const childRuntime = await ModelRuntime.create({ authPath, modelsPath: null });
		const childRegistry = new ModelRegistry(childRuntime);
		assert.equal((await childRegistry.getProviderAuth("openai-codex"))?.auth.apiKey, storedAccess);
		const pi = {
			registerProvider(providerOrName: unknown, config?: unknown) {
				if (typeof providerOrName === "string") {
					childRuntime.registerProvider(providerOrName, config as never);
				} else {
					childRuntime.registerNativeProvider(providerOrName as never);
				}
			},
			unregisterProvider(provider: string) {
				childRuntime.unregisterProvider(provider);
			},
		};
		const state = createChildAuthBootstrapState();
		await applyChildAuthSnapshot(
			pi as never,
			{ modelRegistry: childRegistry } as never,
			{
				version: CHILD_AUTH_PROTOCOL,
				providers: [{ provider: "openai-codex", auth: { apiKey: "selected-parent-key" } }],
			},
			state,
		);
		assert.equal(
			(await childRegistry.getProviderAuth("openai-codex"))?.auth.apiKey,
			"selected-parent-key",
		);
		assert.equal(childRegistry.getProviderAuthStatus("openai-codex").source, "runtime");
		assert.deepEqual([...state.runtimeCredentialProviderIds], ["openai-codex"]);
		assert.equal(readFileSync(authPath, "utf8"), storedAuth);

		await applyChildAuthSnapshot(
			pi as never,
			{ modelRegistry: childRegistry } as never,
			{
				version: CHILD_AUTH_PROTOCOL,
				providers: [{ provider: "openai-codex", auth: { apiKey: "refreshed-parent-key" } }],
			},
			state,
		);
		assert.equal(
			(await childRegistry.getProviderAuth("openai-codex"))?.auth.apiKey,
			"refreshed-parent-key",
		);
		assert.equal(readFileSync(authPath, "utf8"), storedAuth);

		await applyChildAuthSnapshot(
			pi as never,
			{ modelRegistry: childRegistry } as never,
			{ version: CHILD_AUTH_PROTOCOL, providers: [] },
			state,
		);
		assert.equal(childRegistry.getProviderAuthStatus("openai-codex").source, "stored");
		assert.equal((await childRegistry.getProviderAuth("openai-codex"))?.auth.apiKey, storedAccess);
		assert.equal(state.runtimeCredentialProviderIds.size, 0);
		assert.equal(readFileSync(authPath, "utf8"), storedAuth);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("real extension-free child applies parent runtime auth before its first prompt", async () => {
	const root = mkdtempSync(path.join(os.tmpdir(), "pi-subagents-child-auth-process-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const previousPackageDir = process.env.PI_PACKAGE_DIR;
	const childAgentDir = path.join(root, "child-agent");
	const parentAgentDir = path.join(root, "parent-agent");
	const marker = path.join(root, "normal-extension-loaded");
	mkdirSync(path.join(childAgentDir, "extensions"), { recursive: true });
	mkdirSync(parentAgentDir, { recursive: true });
	writeFileSync(
		path.join(childAgentDir, "extensions", "marker.ts"),
		`import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "loaded"); export default function () {}`,
	);
	writeFileSync(
		path.join(childAgentDir, "auth.json"),
		`${JSON.stringify({ "handoff-test": { type: "api_key", key: "child-fallback-key" } })}\n`,
		{ mode: 0o600 },
	);
	let authorization = "";
	const server = createServer((request, response) => {
		authorization = String(request.headers.authorization ?? "");
		request.resume();
		response.writeHead(200, { "content-type": "text/event-stream" });
		const first = {
			id: "chatcmpl-test",
			object: "chat.completion.chunk",
			created: 1,
			model: "bridge-model",
			choices: [
				{
					index: 0,
					delta: { role: "assistant", content: "bridge-ok" },
					finish_reason: null,
				},
			],
		};
		const done = {
			id: "chatcmpl-test",
			object: "chat.completion.chunk",
			created: 1,
			model: "bridge-model",
			choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
		};
		response.end(
			`data: ${JSON.stringify(first)}\n\ndata: ${JSON.stringify(done)}\n\ndata: [DONE]\n\n`,
		);
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => resolve());
	});
	try {
		const address = server.address();
		assert.ok(address && typeof address === "object");
		const runtime = await ModelRuntime.create({
			authPath: path.join(parentAgentDir, "auth.json"),
			modelsPath: null,
		});
		runtime.registerProvider("handoff-test", {
			api: "openai-completions",
			apiKey: "parent-config-fallback",
			baseUrl: `http://127.0.0.1:${address.port}/v1`,
			models: [
				{
					id: "bridge-model",
					name: "Bridge Model",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 8_192,
					maxTokens: 1_024,
				},
			],
		});
		await runtime.setRuntimeApiKey("handoff-test", "parent-runtime-key");
		const modelRegistry = new ModelRegistry(runtime);
		const auth = await createChildAuthSnapshot(modelRegistry, ["handoff-test"]);
		process.env.PI_CODING_AGENT_DIR = childAgentDir;
		process.env.PI_PACKAGE_DIR = path.resolve("node_modules/@earendil-works/pi-coding-agent");
		const result = await runChild({
			task: "Return the provider response.",
			tools: [],
			model: "handoff-test/bridge-model",
			auth,
			thinkingLevel: "off",
			cwd: root,
			timeout: 4,
			projectTrusted: false,
			communication: {
				host: "127.0.0.1",
				port: 31_337,
				token: "a".repeat(64),
			},
			signal: new AbortController().signal,
		});
		assert.equal(result.state, "completed", result.error ?? "Child did not complete.");
		assert.equal(result.result, "bridge-ok");
		assert.equal(authorization, "Bearer parent-runtime-key");
		assert.equal(authorization.includes("child-fallback-key"), false);
		assert.equal(JSON.stringify(result).includes("parent-runtime-key"), false);
		assert.equal(existsSync(marker), false);
		assert.equal(existsSync(path.join(childAgentDir, "sessions")), false);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		if (previousPackageDir === undefined) delete process.env.PI_PACKAGE_DIR;
		else process.env.PI_PACKAGE_DIR = previousPackageDir;
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		rmSync(root, { recursive: true, force: true });
	}
});

test("child auth bootstrap overrides and later restores a child credential", async () => {
	const root = mkdtempSync(path.join(os.tmpdir(), "pi-subagents-child-auth-apply-"));
	try {
		const parentRuntime = await runtimeWithAuth(path.join(root, "parent"), "parent-stored-key");
		await parentRuntime.setRuntimeApiKey("anthropic", "selected-parent-key");
		const snapshot = await createChildAuthSnapshot(new ModelRegistry(parentRuntime), ["anthropic"]);

		const childRuntime = await runtimeWithAuth(path.join(root, "child"), "child-fallback-key");
		const childRegistry = new ModelRegistry(childRuntime);
		const childModel = childRegistry.getAll().find((model) => model.provider === "anthropic");
		assert.ok(childModel);
		const pi = {
			registerProvider(providerOrName: unknown, config?: unknown) {
				if (typeof providerOrName === "string") {
					childRuntime.registerProvider(providerOrName, config as never);
				} else {
					childRuntime.registerNativeProvider(providerOrName as never);
				}
			},
			unregisterProvider(provider: string) {
				childRuntime.unregisterProvider(provider);
			},
			async setModel() {
				return true;
			},
		};
		const ctx = { modelRegistry: childRegistry, model: childModel };
		const state = createChildAuthBootstrapState();
		await applyChildAuthSnapshot(pi as never, ctx as never, snapshot, state);
		assert.equal(
			(await childRegistry.getProviderAuth("anthropic"))?.auth.apiKey,
			"selected-parent-key",
		);

		await applyChildAuthSnapshot(
			pi as never,
			ctx as never,
			{ version: CHILD_AUTH_PROTOCOL, providers: [] },
			state,
		);
		assert.equal(
			(await childRegistry.getProviderAuth("anthropic"))?.auth.apiKey,
			"child-fallback-key",
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("parent child auth channel waits for a matching bounded acknowledgement", async () => {
	const parentToChild = new PassThrough();
	const childToParent = new PassThrough();
	const channel = new ParentChildAuthChannel(parentToChild, childToParent);
	let buffer = "";
	parentToChild.setEncoding("utf8");
	parentToChild.on("data", (chunk: string) => {
		buffer += chunk;
		const index = buffer.indexOf("\n");
		if (index < 0) return;
		const request = parseChildAuthRequest(JSON.parse(buffer.slice(0, index)));
		childToParent.write(`${JSON.stringify(childAuthAck(request.id, true))}\n`);
	});
	const snapshot: ChildAuthSnapshot = {
		version: CHILD_AUTH_PROTOCOL,
		providers: [{ provider: "anthropic", auth: { apiKey: "private-parent-key" } }],
	};
	try {
		await channel.send(snapshot, undefined, 1_000);
		assert.match(buffer, /private-parent-key/);
	} finally {
		channel.close();
		parentToChild.destroy();
		childToParent.destroy();
	}
});

test("child auth protocol errors never include credential values", () => {
	const secret = "secret-that-must-not-appear";
	assert.throws(
		() =>
			parseChildAuthRequest({
				version: CHILD_AUTH_PROTOCOL,
				id: "bad",
				snapshot: {
					version: CHILD_AUTH_PROTOCOL,
					providers: [{ provider: "anthropic", auth: { apiKey: secret }, env: { BAD: 1 } }],
				},
			}),
		(error: unknown) => error instanceof Error && !error.message.includes(secret),
	);
});
