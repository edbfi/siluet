import { expect, test } from "bun:test";
import { once } from "node:events";
import { watch } from "node:fs";
import { copyFile, exists, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unsupportedPlatformMessage } from "../src/lib/server/platform";
import { launchStudio } from "./start";

test("retries a dynamic port collision with a new matching origin", async () => {
	const origins: string[] = [];
	const code = await launchStudio(
		{ SILUET_SERVER_PORT: "0" },
		async (env) => {
			origins.push(env.SILUET_SERVER_ORIGIN);
			expect(env.SILUET_SERVER_PORT).toBe(new URL(env.SILUET_SERVER_ORIGIN).port);
			return origins.length === 1 ? 75 : 0;
		},
		() => (origins.length === 0 ? 41234 : 42020),
	);
	expect(code).toBe(0);
	expect(origins).toEqual(["http://127.0.0.1:41234", "http://127.0.0.1:42020"]);
});

test("fixed listeners keep their port and reject a mismatched origin before launch", async () => {
	const origins: string[] = [];
	const start = async (env: { SILUET_SERVER_ORIGIN: string }) => {
		origins.push(env.SILUET_SERVER_ORIGIN);
		return 75;
	};
	expect(await launchStudio({ SILUET_SERVER_HOST: "::1" }, start)).toBe(75);
	await expect(
		launchStudio({ SILUET_SERVER_ORIGIN: "http://127.0.0.1:3100" }, start),
	).rejects.toThrow("origin");
	expect(origins).toEqual(["http://[::1]:3000"]);
});

test("the launcher and the server it starts create files for the owner only", () => {
	const child = Bun.spawnSync(
		[
			process.execPath,
			"--preload",
			join(import.meta.dir, "../tests/fixtures/report-umask.ts"),
			join(import.meta.dir, "start.ts"),
		],
		{ env: { ...process.env, SILUET_SERVER_HOST: "localhost" } },
	);
	expect(child.exitCode).not.toBe(0);
	expect(child.stderr.toString()).toContain("umask 77\n");
});

test("a foreign launcher refuses before selecting a port", async () => {
	const root = await mkdtemp(join(tmpdir(), "siluet-foreign-launcher-"));
	try {
		const sentinel = join(root, "served");
		const child = Bun.spawnSync(
			[
				process.execPath,
				"--preload",
				join(import.meta.dir, "../tests/fixtures/foreign-platform.ts"),
				join(import.meta.dir, "start.ts"),
			],
			{
				env: {
					...process.env,
					SILUET_SERVER_PORT: "0",
					SILUET_TEST_PLATFORM: "freebsd",
					SILUET_TEST_SENTINEL: sentinel,
				},
			},
		);
		expect(child.stderr.toString()).toBe(`${unsupportedPlatformMessage}\n`);
		expect(child.exitCode).toBe(1);
		expect(await exists(sentinel)).toBe(false);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

const terminalSignals = ["SIGINT", "SIGHUP", "SIGKILL", "second interrupt"] as const;
test.each(terminalSignals)("the launcher delivers %s to a draining server", async (scenario) => {
	const root = await mkdtemp(join(tmpdir(), "siluet-interrupt-"));
	try {
		await mkdir(join(root, "scripts"));
		await mkdir(join(root, "build"));
		await copyFile(new URL("./start.ts", import.meta.url), join(root, "scripts/start.ts"));
		// Mirror the adapter's second-signal exit while the first signal drains requests.
		await writeFile(
			join(root, "build/index.js"),
			`
			let draining = false;
			function shutdown() {
				if (draining) process.exit(1);
				draining = true;
                console.log("draining");
				setTimeout(async () => { await Bun.write("drained","yes"); process.exit(0); },200);
			}
			process.on("SIGINT",shutdown);
			process.on("SIGTERM",shutdown);
			setTimeout(()=>process.exit(2),3000);
			console.log("ready");`,
		);
		const child = Bun.spawn([process.execPath, join(root, "scripts/start.ts")], {
			cwd: root,
			detached: true,
			stdout: "pipe",
			stderr: "ignore",
		});
		const reader = child.stdout.getReader();
		const { value } = await reader.read();
		expect(new TextDecoder().decode(value).trim()).toBe("ready");
		if (scenario === "SIGKILL") {
			const watcher = watch(root);
			try {
				const finished = once(watcher, "change", { signal: AbortSignal.timeout(2500) });
				process.kill(-child.pid, "SIGKILL");
				await child.exited;
				expect((await finished)[1]).toBe("drained");
			} finally {
				watcher.close();
			}
			return;
		}
		process.kill(-child.pid, scenario === "second interrupt" ? "SIGINT" : scenario);
		const drained = new TextDecoder().decode((await reader.read()).value).trim();
		expect(drained).toBe("draining");
		if (scenario === "second interrupt") process.kill(-child.pid, "SIGINT");
		const code = await child.exited;
		expect(code).toBe(scenario === "second interrupt" ? 1 : 0);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("launcher cancellation reaches active preparation before the adapter drains", async () => {
	const root = await mkdtemp(join(tmpdir(), "siluet-active-drain-"));
	try {
		await mkdir(join(root, "build"));
		await mkdir(join(root, "scripts"));
		await copyFile(`${import.meta.dir}/start.ts`, join(root, "scripts/start.ts"));
		// The fake adapter drains only after the runtime has seen siluet:stopping.
		await writeFile(
			join(root, "build/index.js"),
			`
			let cancelled = false;
			process.on("siluet:stopping", () => { cancelled = true; });
			process.on("SIGTERM", () => { process.exit(cancelled ? 0 : 2); });
			process.send("ready");
		`,
		);
		const ready = Promise.withResolvers<void>();
		const server = Bun.spawn([process.execPath, join(root, "scripts/start.ts"), "--serve"], {
			ipc(message) {
				if (message === "ready") ready.resolve();
			},
		});
		try {
			await ready.promise;
			server.send("stop");
			expect(await server.exited).toBe(0);
		} finally {
			server.kill();
			await server.exited;
		}
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("the launcher raises the listener body limit for local image staging", async () => {
	const limits: (string | undefined)[] = [];
	await launchStudio({ SILUET_SERVER_PORT: "3100" }, async (env) => {
		limits.push(env.SILUET_SERVER_BODY_SIZE_LIMIT);
		return 0;
	});
	expect(limits).toEqual(["32000000"]);
});
