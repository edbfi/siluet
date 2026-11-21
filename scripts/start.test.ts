import { expect, test } from "bun:test";
import { once } from "node:events";
import { watch } from "node:fs";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

const terminalSignals =
	process.platform === "win32"
		? []
		: (["SIGINT", "SIGHUP", "SIGKILL", "second interrupt"] as const);
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
