import { fork } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { expect } from "@playwright/test";

export async function startStudio(
	directory: string,
	port = "0",
	collide = false,
	env: Record<string, string> = {},
	buildRoot = process.cwd(),
) {
	const processHandle = fork(
		collide ? "tests/browser/occupied-port.ts" : join(buildRoot, "scripts/start.ts"),
		[],
		{
			execPath: process.execPath,
			execArgv: ["--preload", join(process.cwd(), "tests/browser/launcher-control.ts")],
			cwd: process.cwd(),
			env: { ...process.env, ...env, SILUET_DATA_DIR: directory, SILUET_SERVER_PORT: port },
			stdio: ["ignore", "pipe", "pipe", "ipc"],
		},
	);
	if (!processHandle.stdout || !processHandle.stderr) throw new Error("Missing studio output.");
	let diagnostics = "";
	processHandle.stderr.on("data", (chunk) => {
		diagnostics += chunk.toString();
	});
	const closed = once(processHandle, "close");
	const lines = createInterface({ input: processHandle.stdout });
	const listening = Promise.withResolvers<URL>();
	let token = "";
	let announcements = 0;
	let setupUrl = "";
	lines.on("line", (line) => {
		diagnostics += `${line}\n`;
		const address = /^Listening on (http:\/\/127\.0\.0\.1:\d+)\/?$/.exec(line);
		if (address) listening.resolve(new URL(address[1]));
		if (line.startsWith("Claim token: ")) {
			announcements++;
			token = line.slice("Claim token: ".length);
		}
		if (line.startsWith("Setup URL: ")) setupUrl = line.slice("Setup URL: ".length);
	});
	const timer = setTimeout(
		() => listening.reject(new Error("Missing listener announcement")),
		10000,
	);
	const stop = async (expectClean = true) => {
		if (processHandle.connected) {
			processHandle.send("stop", () => {});
		}
		const [code] = await closed;
		lines.close();
		if (expectClean) expect(code).toBe(0);
	};
	try {
		const origin = await Promise.race([
			listening.promise,
			closed.then(() => {
				if (announcements) throw new Error("Setup was announced before failed startup.");
				throw new Error("Studio stopped before it was ready");
			}),
		]);
		return {
			origin,
			diagnostics: () => diagnostics,
			announcements: () => announcements,
			token: () => token,
			setupUrl: () => setupUrl,
			stop,
		};
	} catch (error) {
		await stop(false);
		throw error;
	} finally {
		clearTimeout(timer);
	}
}
