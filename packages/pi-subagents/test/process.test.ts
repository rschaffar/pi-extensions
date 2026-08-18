import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test, vi } from "vitest";
import { CHILD_AUTH_BOOTSTRAP_PATH } from "../src/child-auth.js";
import { CHILD_AUTH_PROTOCOL, type ChildAuthSnapshot } from "../src/child-auth-protocol.js";
import {
	buildPiArgs,
	childCommunicationBridgePath,
	resolveTimeoutMs,
	runChild,
	terminateWindowsProcessTree,
} from "../src/process.js";
import type { ChildControl, ChildRequest } from "../src/types.js";

let directory: string;
let previousPackageDirectory: string | undefined;

beforeEach(() => {
	directory = mkdtempSync(path.join(os.tmpdir(), "pi-subagents-process-"));
	previousPackageDirectory = process.env.PI_PACKAGE_DIR;
});

afterEach(() => {
	if (previousPackageDirectory === undefined) delete process.env.PI_PACKAGE_DIR;
	else process.env.PI_PACKAGE_DIR = previousPackageDirectory;
	rmSync(directory, { recursive: true, force: true });
	vi.useRealTimers();
	vi.restoreAllMocks();
});

test("buildPiArgs isolates the RPC child and preserves selected communication tools", () => {
	const args = buildPiArgs(childRequest());
	assert.deepEqual(args.slice(0, 7), [
		"--mode",
		"rpc",
		"--no-session",
		"--no-extensions",
		"--no-skills",
		"--no-prompt-templates",
		"-e",
	]);
	assert.equal(args[7], CHILD_AUTH_BOOTSTRAP_PATH);
	assert.equal(args[8], "-e");
	assert.equal(args[9], childCommunicationBridgePath());
	assert.equal(args[args.indexOf("--model") + 1], "test-provider/test-model");
	assert.equal(args[args.indexOf("--thinking") + 1], "medium");
	assert.ok(args.includes("--no-approve"));
	assert.equal(args[args.indexOf("--tools") + 1], "read,grep,find,ls,subagent_send,subagent_wait");
	assert.doesNotMatch(args.join(" "), /\bbash\b|\bwrite\b|append-system-prompt/u);
	assert.equal(args.includes("Task: task"), false);

	const writable = buildPiArgs(
		childRequest({
			tools: ["read", "bash", "write", "subagent_send", "subagent_wait"],
			thinkingLevel: "xhigh",
			projectTrusted: true,
		}),
	);
	assert.ok(writable.includes("--approve"));
	assert.equal(writable[writable.indexOf("--thinking") + 1], "xhigh");
	assert.equal(
		writable[writable.indexOf("--tools") + 1],
		"read,bash,write,subagent_send,subagent_wait",
	);

	const noWorkTools = buildPiArgs(childRequest({ tools: [] }));
	assert.equal(noWorkTools[noWorkTools.indexOf("--tools") + 1], "subagent_send,subagent_wait");
});

test("runChild classifies completed and partial RPC output", async () => {
	installFakePi(`
async function handle(command) {
  if (command.type !== "prompt") return;
  respond(command);
  if (command.message.includes("partial")) {
    event(message("partial evidence", "error"));
    console.error("child failed");
  } else {
    event(message("completed evidence"));
  }
  event({ type: "agent_settled" });
}
`);
	const completed = await runChild(childRequest({ task: "complete" }));
	assert.equal(completed.state, "completed");
	assert.equal(completed.result, "completed evidence");

	const partial = await runChild(childRequest({ task: "partial" }));
	assert.equal(partial.state, "partial");
	assert.equal(partial.result, "partial evidence");
	assert.match(partial.error ?? "", /child failed/);
});

test("runChild requires a settled terminal result and preserves incomplete evidence", async () => {
	installFakePi(`
async function handle(command) {
  if (command.type !== "prompt") return;
  respond(command);
  if (command.message.includes("length")) event(message("cut-off evidence", "length"));
  else if (command.message.includes("nonterminal")) event(message("intermediate evidence", "toolUse"));
  else process.stdout.write("{malformed\\n");
  event({ type: "agent_settled" });
}
`);
	const lengthLimited = await runChild(childRequest({ task: "length" }));
	assert.equal(lengthLimited.state, "partial");
	assert.equal(lengthLimited.result, "cut-off evidence");
	assert.match(lengthLimited.error ?? "", /model limit/i);
	assert.match(lengthLimited.limitations.join("\n"), /model output limit/i);

	const nonterminal = await runChild(childRequest({ task: "nonterminal" }));
	assert.equal(nonterminal.state, "partial");
	assert.equal(nonterminal.result, "intermediate evidence");
	assert.match(nonterminal.error ?? "", /without a terminal assistant result/i);

	const missing = await runChild(childRequest({ task: "missing" }));
	assert.equal(missing.state, "failed");
	assert.match(missing.error ?? "", /without a terminal assistant result/i);
	assert.match(missing.limitations.join("\n"), /malformed/i);
});

test("runChild ignores an oversized RPC event and preserves later terminal output", async () => {
	installFakePi(`
async function handle(command) {
  if (command.type !== "prompt") return;
  respond(command);
  process.stdout.write("x".repeat(256 * 1024 + 1) + "\\n");
  event(message("usable output"));
  event({ type: "agent_settled" });
}
`);
	const result = await runChild(childRequest());
	assert.equal(result.state, "completed");
	assert.equal(result.result, "usable output");
	assert.match(result.limitations.join("\n"), /malformed or oversized/i);
});

test("runChild refreshes runtime auth before accepted RPC steering", async () => {
	installFakePi(`
async function handle(command) {
  if (command.type === "prompt") {
    respond(command);
    return;
  }
  if (command.type === "steer") {
    respond(command);
    event(message("answered with " + latestAuthRequest.snapshot.providers[0].auth.apiKey + ": " + command.message));
    event({ type: "agent_settled" });
  }
}
`);
	let resolveControl!: (control: ChildControl) => void;
	const controlReady = new Promise<ChildControl>((resolve) => {
		resolveControl = resolve;
	});
	const work = runChild(childRequest({ onControl: resolveControl }));
	const control = await controlReady;
	await control.send("question from main", {
		version: CHILD_AUTH_PROTOCOL,
		providers: [{ provider: "test-provider", auth: { apiKey: "refreshed-key" } }],
	});
	const result = await work;
	assert.equal(result.state, "completed");
	assert.equal(result.result, "answered with refreshed-key: question from main");
	await assert.rejects(
		() => control.send("late", emptyAuth()),
		/no longer accepting|no longer active/i,
	);
});

test("runChild surfaces an RPC steering rejection without terminating accepted work", async () => {
	installFakePi(`
async function handle(command) {
  if (command.type === "prompt") {
    respond(command);
    return;
  }
  if (command.type === "steer") {
    respond(command, false, "steer rejected");
  }
}
`);
	const controller = new AbortController();
	let resolveControl!: (control: ChildControl) => void;
	const controlReady = new Promise<ChildControl>((resolve) => {
		resolveControl = resolve;
	});
	const work = runChild(childRequest({ signal: controller.signal, onControl: resolveControl }));
	const control = await controlReady;
	await assert.rejects(() => control.send("question", emptyAuth()), /steer rejected/i);
	controller.abort();
	assert.equal((await work).state, "cancelled");
});

test("runChild rejects asynchronous RPC stdin write errors without an unhandled error", async () => {
	installFakePi(`
async function handle(command) {
  if (command.type !== "prompt") return;
  process.stdin.on("error", () => undefined);
  fs.closeSync(0);
  respond(command);
}
setInterval(() => {}, 1000);
`);
	const controller = new AbortController();
	let resolveControl!: (control: ChildControl) => void;
	const controlReady = new Promise<ChildControl>((resolve) => {
		resolveControl = resolve;
	});
	const work = runChild(childRequest({ signal: controller.signal, onControl: resolveControl }));
	const control = await controlReady;
	await assert.rejects(
		() => control.send("question after stdin closed", emptyAuth()),
		/EPIPE|stdin|write/iu,
	);
	controller.abort();
	assert.equal((await work).state, "cancelled");
});

test("runChild aborts an in-flight RPC steering command", async () => {
	installFakePi(`
async function handle(command) {
  if (command.type === "prompt") respond(command);
}
setInterval(() => {}, 1000);
`);
	const processController = new AbortController();
	let resolveControl!: (control: ChildControl) => void;
	const controlReady = new Promise<ChildControl>((resolve) => {
		resolveControl = resolve;
	});
	const work = runChild(
		childRequest({ signal: processController.signal, onControl: resolveControl }),
	);
	const control = await controlReady;
	const sendController = new AbortController();
	const pending = control.send("unacknowledged question", emptyAuth(), sendController.signal);
	sendController.abort();
	await assert.rejects(pending, (error: Error) => error.name === "AbortError");
	processController.abort();
	assert.equal((await work).state, "cancelled");
});

test("runChild bounds child result text below the complete tool-output budget", async () => {
	installFakePi(`
async function handle(command) {
  if (command.type !== "prompt") return;
  respond(command);
  event(message("x".repeat(40 * 1024)));
  event({ type: "agent_settled" });
}
`);
	const result = await runChild(childRequest());
	assert.equal(result.state, "completed");
	assert.equal(result.truncated, true);
	assert.ok(Buffer.byteLength(result.result ?? "", "utf8") <= 32 * 1024);
	assert.match(result.limitations.join("\n"), /truncated/i);
});

test("passes broker and runtime auth credentials through private descriptors", async () => {
	const authSecret = "parent-runtime-secret";
	installFakePi(`
async function handle(command) {
  if (command.type !== "prompt") return;
  respond(command);
  const initialEnvironment = process.platform === "linux"
    ? fs.readFileSync("/proc/self/environ")
    : Buffer.from(Object.entries(process.env).map(([key, value]) => key + "=" + value).join("\\0"));
  const authSecret = "parent-runtime-secret";
  const text = JSON.stringify({
    credentialsReceived: brokerCredentials.host === "127.0.0.1" && brokerCredentials.port === 31337,
    authReceived: latestAuthRequest.snapshot.providers[0].auth.apiKey === authSecret,
    initialEnvironmentContainsBrokerToken: initialEnvironment.includes(Buffer.from(brokerCredentials.token)),
    initialEnvironmentContainsAuth: initialEnvironment.includes(Buffer.from(authSecret)),
    argvContainsAuth: process.argv.includes(authSecret),
    preludeContainsAuth: JSON.stringify(authPrelude).includes(authSecret),
    descriptorMarker: process.env.PI_SUBAGENT_BROKER_FD,
  });
  event(message(text));
  event({ type: "agent_settled" });
}
`);
	const result = await runChild(
		childRequest({
			auth: {
				version: CHILD_AUTH_PROTOCOL,
				providers: [{ provider: "test-provider", auth: { apiKey: authSecret } }],
			},
		}),
	);
	assert.equal(result.state, "completed");
	assert.deepEqual(JSON.parse(result.result ?? "{}"), {
		credentialsReceived: true,
		authReceived: true,
		initialEnvironmentContainsBrokerToken: false,
		initialEnvironmentContainsAuth: false,
		argvContainsAuth: false,
		preludeContainsAuth: false,
		descriptorMarker: "3",
	});
});

test("handles late credential-pipe errors after child launch failure", async () => {
	installFakePi("async function handle() {}\n");
	const removedCwd = path.join(directory, "removed-cwd");
	mkdirSync(removedCwd);
	rmSync(removedCwd, { recursive: true });

	const result = await runChild(childRequest({ cwd: removedCwd }));
	assert.equal(result.state, "failed");
	assert.match(result.error ?? "", /ENOENT|not found/iu);
	await new Promise<void>((resolve) => setImmediate(resolve));
});

test("resolves optional execution timeouts with Pi bash semantics", () => {
	assert.equal(resolveTimeoutMs(undefined), undefined);
	assert.equal(resolveTimeoutMs(0.025), 25);
	assert.equal(resolveTimeoutMs(2_147_483.647), 2_147_483_647);
	assert.throws(() => resolveTimeoutMs(0), /finite number of seconds/);
	assert.throws(() => resolveTimeoutMs(Number.POSITIVE_INFINITY), /finite number of seconds/);
	assert.throws(() => resolveTimeoutMs(2_147_483.648), /maximum is 2147483\.647 seconds/);
});

test("runChild starts its deadline after RPC readiness and honors cancellation", async () => {
	installFakePi(`
async function handle(command) {
  if (command.type === "prompt") respond(command);
}
setInterval(() => {}, 1000);
`);
	let timeoutReady!: (control: ChildControl) => void;
	const timedOut = runChild(
		childRequest({
			timeout: 0.025,
			onControl: (control) => timeoutReady(control),
		}),
	);
	await new Promise<ChildControl>((resolve) => {
		timeoutReady = resolve;
	});
	assert.equal((await timedOut).state, "timed_out");

	const controller = new AbortController();
	let cancelReady!: (control: ChildControl) => void;
	const work = runChild(
		childRequest({
			signal: controller.signal,
			onControl: (control) => cancelReady(control),
		}),
	);
	await new Promise<ChildControl>((resolve) => {
		cancelReady = resolve;
	});
	controller.abort();
	assert.equal((await work).state, "cancelled");
});

test("runChild reuses one termination flow when timeout and cancellation race", {
	skip: process.platform === "win32",
}, async () => {
	installFakePi(`
process.on("SIGTERM", () => undefined);
async function handle(command) {
  if (command.type === "prompt") respond(command);
}
setInterval(() => {}, 1000);
`);
	const signals: Array<string | number | undefined> = [];
	const originalKill = process.kill.bind(process);
	vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
		if (pid < 0) signals.push(signal);
		return originalKill(pid, signal);
	});
	const controller = new AbortController();
	let resolveControl!: (control: ChildControl) => void;
	const ready = new Promise<ChildControl>((resolve) => {
		resolveControl = resolve;
	});
	const work = runChild(
		childRequest({ signal: controller.signal, timeout: 0.05, onControl: resolveControl }),
	);
	await ready;
	setTimeout(() => controller.abort(), 60);
	const result = await work;
	assert.equal(result.state, "cancelled");
	assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
});

test("Windows process-tree termination awaits taskkill completion", async () => {
	const childKill = vi.fn();
	const child = {
		pid: 4242,
		kill: childKill,
	} as unknown as ChildProcess;
	const treeKiller = new EventEmitter() as ChildProcess;
	treeKiller.kill = vi.fn();
	const spawnTreeKillerMock = vi.fn(() => treeKiller);
	const spawnTreeKiller =
		spawnTreeKillerMock as unknown as typeof import("node:child_process").spawn;
	let settled = false;
	const work = terminateWindowsProcessTree(
		child,
		spawnTreeKiller,
		"C:\\Windows\\System32\\taskkill.exe",
	).then(() => {
		settled = true;
	});
	await Promise.resolve();
	assert.equal(settled, false);
	assert.deepEqual(spawnTreeKillerMock.mock.calls[0]?.slice(0, 2), [
		"C:\\Windows\\System32\\taskkill.exe",
		["/PID", "4242", "/T", "/F"],
	]);
	assert.equal(childKill.mock.calls.length, 0);
	treeKiller.emit("close", 0, null);
	await work;
	assert.equal(settled, true);
});

test("Windows process-tree termination bounds a hung taskkill helper", async () => {
	vi.useFakeTimers();
	const childKill = vi.fn();
	const child = {
		pid: 4242,
		kill: childKill,
	} as unknown as ChildProcess;
	const treeKiller = new EventEmitter() as ChildProcess;
	const treeKillerKill = vi.fn();
	treeKiller.kill = treeKillerKill;
	const spawnTreeKiller = vi.fn(
		() => treeKiller,
	) as unknown as typeof import("node:child_process").spawn;
	let settled = false;
	const work = terminateWindowsProcessTree(
		child,
		spawnTreeKiller,
		"C:\\Windows\\System32\\taskkill.exe",
		10,
	).then(() => {
		settled = true;
	});
	await vi.advanceTimersByTimeAsync(9);
	assert.equal(settled, false);
	await vi.advanceTimersByTimeAsync(1);
	await work;
	assert.equal(settled, true);
	assert.deepEqual(treeKillerKill.mock.calls, [["SIGKILL"]]);
	assert.deepEqual(childKill.mock.calls, [["SIGKILL"]]);
});

function childRequest(overrides: Partial<ChildRequest> = {}): ChildRequest {
	return {
		task: "task",
		tools: ["read", "grep", "find", "ls"],
		model: "test-provider/test-model",
		auth: emptyAuth(),
		thinkingLevel: "medium",
		cwd: directory,
		projectTrusted: false,
		communication: {
			host: "127.0.0.1",
			port: 31_337,
			token: "a".repeat(64),
		},
		signal: new AbortController().signal,
		...overrides,
	};
}

function emptyAuth(): ChildAuthSnapshot {
	return { version: CHILD_AUTH_PROTOCOL, providers: [] };
}

function installFakePi(source: string): void {
	const packageDirectory = path.join(directory, "pi-core");
	mkdirSync(packageDirectory, { recursive: true });
	writeFileSync(
		path.join(packageDirectory, "fake-pi.mjs"),
		`import fs from "node:fs";
const brokerCredentials = JSON.parse(fs.readFileSync(3, "utf8"));
const authPrelude = JSON.parse(fs.readFileSync(6, "utf8"));
const authInput = fs.createReadStream("", { fd: 4, autoClose: false, encoding: "utf8" });
const authOutput = fs.createWriteStream("", { fd: 5, autoClose: false });
let authBuffer = "";
let latestAuthRequest;
authInput.on("data", (chunk) => {
  authBuffer += chunk;
  while (true) {
    const newline = authBuffer.indexOf("\\n");
    if (newline < 0) break;
    const line = authBuffer.slice(0, newline);
    authBuffer = authBuffer.slice(newline + 1);
    if (!line.trim()) continue;
    latestAuthRequest = JSON.parse(line);
    authOutput.write(JSON.stringify({
      version: "pi-subagents:child-auth:v1",
      id: latestAuthRequest.id,
      ok: true,
    }) + "\\n");
  }
});
const event = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const respond = (command, success = true, error) => event({
  id: command.id,
  type: "response",
  command: command.type,
  success,
  ...(error ? { error } : {}),
});
const message = (text, stopReason = "stop") => ({
  type: "message_end",
  message: { role: "assistant", content: [{ type: "text", text }], stopReason },
});
${source}
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
  while (true) {
    const newline = input.indexOf("\\n");
    if (newline < 0) break;
    const line = input.slice(0, newline);
    input = input.slice(newline + 1);
    if (line.trim()) void handle(JSON.parse(line));
  }
});
`,
	);
	writeFileSync(
		path.join(packageDirectory, "package.json"),
		JSON.stringify({
			name: "@earendil-works/pi-coding-agent",
			bin: { pi: "./fake-pi.mjs" },
		}),
	);
	process.env.PI_PACKAGE_DIR = packageDirectory;
}
