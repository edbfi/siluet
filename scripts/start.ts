import { fork } from "node:child_process";
import { type EventEmitter, once } from "node:events";

import { fileURLToPath } from "node:url";

type Settings = Record<string, string | undefined>;
type Listener = Settings & {
	SILUET_SERVER_PORT: string;
	SILUET_SERVER_ORIGIN: string;
};

const bindCollision = 75;

async function availablePort(hostname: string) {
	const listener = Bun.serve({
		hostname,
		port: 0,
		fetch: () => new Response(null, { status: 503 }),
	});
	const port = listener.port;
	await listener.stop(true);
	if (!port) throw new Error("Could not select a loopback port.");
	return port;
}

async function startProcess(env: Listener) {
	// Isolate console signals. Forward each stop over IPC, including on Windows
	// where killing the child would skip the Bun adapter's graceful shutdown.
	const child = fork(import.meta.path, ["--serve"], {
		execPath: process.execPath,
		execArgv: [],
		detached: true,
		env,
		stdio: ["ignore", "pipe", "pipe", "ipc"],
	});
	child.stdout?.pipe(process.stdout, { end: false });
	child.stderr?.pipe(process.stderr, { end: false });
	const stop = () => {
		if (child.connected) child.send("stop", () => {});
	};
	const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
	for (const signal of signals) process.on(signal, stop);
	try {
		const [code] = await once(child, "close");
		return typeof code === "number" ? code : 1;
	} finally {
		for (const signal of signals) process.off(signal, stop);
	}
}

export async function launchStudio(
	settings: Settings,
	start: (env: Listener) => Promise<number> = startProcess,
	selectPort: (host: string) => number | Promise<number> = availablePort,
) {
	const host = settings.SILUET_SERVER_HOST ?? "127.0.0.1";
	if (host !== "127.0.0.1" && host !== "::1") throw new Error("Use a numeric loopback host.");
	const value = settings.SILUET_SERVER_PORT ?? "3000";
	if (!/^\d{1,5}$/.test(value) || Number(value) > 65535) throw new Error("Invalid listener port.");
	const requested = Number(value);
	for (let attempt = 0; attempt < 5; attempt++) {
		const port = requested || (await selectPort(host));
		const origin = new URL(`http://${host === "::1" ? "[::1]" : host}:${port}`).origin;
		if (settings.SILUET_SERVER_ORIGIN !== undefined && settings.SILUET_SERVER_ORIGIN !== origin) {
			throw new Error("The configured origin must match the loopback listener.");
		}
		const code = await start({
			...settings,
			SILUET_SERVER_HOST: host,
			SILUET_SERVER_PORT: String(port),
			SILUET_SERVER_ORIGIN: origin,
		});
		if (code !== bindCollision || requested) return code;
	}
	throw new Error("Could not bind a free loopback port.");
}

if (import.meta.main) {
	if (process.argv[2] === "--serve") {
		try {
			process.chdir(fileURLToPath(new URL("../", import.meta.url)));
			const lifecycle: EventEmitter = process;
			let announce: (() => void) | undefined;
			lifecycle.once("siluet:ready", (callback: () => void) => {
				announce = callback;
			});
			const stop = () => {
				if (!lifecycle.emit("SIGTERM", "SIGTERM")) process.exit(0);
			};
			process.on("message", (message) => {
				if (message === "stop") stop();
			});
			process.once("disconnect", stop);
			lifecycle.once("sveltekit:shutdown", () => {
				process.off("disconnect", stop);
				if (process.connected) process.disconnect?.();
			});
			await import(new URL("../build/index.js", import.meta.url).href);
			announce?.();
		} catch (error) {
			if (!(error instanceof Error) || !("code" in error) || error.code !== "EADDRINUSE")
				throw error;
			console.error("The selected studio port is already in use.");
			process.exit(bindCollision);
		}
	} else {
		process.exitCode = await launchStudio(process.env);
	}
}
