import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { PiInvocationError, resolvePiInvocation } from "../src/pi-invocation.js";

async function fixture(run: (root: string) => Promise<void>): Promise<void> {
	const root = await mkdtemp(join(tmpdir(), "pi-subagents-invocation-test-"));
	try {
		await run(root);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

async function createCorePackage(root: string, includeCli = true): Promise<string> {
	const packageDirectory = join(root, "core package");
	await mkdir(packageDirectory, { recursive: true });
	await writeFile(
		join(packageDirectory, "package.json"),
		JSON.stringify({
			name: "@earendil-works/pi-coding-agent",
			bin: { pi: "dist/bundle/cli.js" },
		}),
	);
	if (includeCli) {
		await mkdir(join(packageDirectory, "dist/bundle"), { recursive: true });
		await writeFile(join(packageDirectory, "dist/bundle/cli.js"), "console.log('pi');\n");
	}
	return packageDirectory;
}

test("Pi invocation resolves Node and Bun package entrypoints without PATH lookup", async () => {
	await fixture(async (root) => {
		const packageDirectory = await createCorePackage(root);
		const realPackageDirectory = await realpath(packageDirectory);
		assert.deepEqual(
			resolvePiInvocation(["--name", "child"], {
				execPath: "/runtime path/node",
				packageDir: packageDirectory,
				runtimeKind: "node",
			}),
			{
				command: "/runtime path/node",
				args: [join(realPackageDirectory, "dist/bundle/cli.js"), "--name", "child"],
			},
		);
		assert.deepEqual(
			resolvePiInvocation([], {
				execPath: "/runtime path/bun",
				packageDir: packageDirectory,
				runtimeKind: "bun",
			}),
			{
				command: "/runtime path/bun",
				args: [join(realPackageDirectory, "dist/bundle/cli.js")],
			},
		);
	});
});

test("Pi invocation accepts a standalone executable when its declared bundle is absent", async () => {
	await fixture(async (root) => {
		const packageDirectory = await createCorePackage(root, false);
		const standalone = join(packageDirectory, "pi");
		await writeFile(standalone, "#!/bin/sh\nexit 0\n");
		await chmod(standalone, 0o700);
		const realStandalone = await realpath(standalone);
		assert.deepEqual(
			resolvePiInvocation(["--name", "child"], {
				execPath: standalone,
				packageDir: packageDirectory,
				runtimeKind: "bun",
			}),
			{ command: realStandalone, args: ["--name", "child"] },
		);
	});
});

test("Pi invocation fails closed for missing, escaping, or unsupported runtimes", async () => {
	await fixture(async (root) => {
		const packageDirectory = await createCorePackage(root, false);
		assert.throws(
			() =>
				resolvePiInvocation([], {
					execPath: "/node",
					packageDir: packageDirectory,
					runtimeKind: "node",
				}),
			PiInvocationError,
		);
		await writeFile(
			join(packageDirectory, "package.json"),
			JSON.stringify({
				name: "@earendil-works/pi-coding-agent",
				bin: { pi: "../escape.js" },
			}),
		);
		assert.throws(
			() =>
				resolvePiInvocation([], {
					execPath: "/other",
					packageDir: packageDirectory,
					runtimeKind: "unsupported",
				}),
			PiInvocationError,
		);
	});
});
