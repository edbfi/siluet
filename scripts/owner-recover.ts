import {
	requireSupportedPlatform,
	UnsupportedPlatformError,
	unsupportedPlatformMessage,
} from "../src/lib/server/platform";

async function main() {
	// Refuse before loading storage and its native bindings.
	requireSupportedPlatform();
	// Files recovery creates or rewrites are the owner's alone.
	process.umask(0o077);
	const input = process.stdin,
		output = process.stderr;
	if (!input.isTTY || !output.isTTY) throw new Error("Run recovery from an interactive terminal.");
	const [{ recoverOwner }, { openRuntimeInstallation }, { hashPassword }, { ownerDirectory }] =
		await Promise.all([
			import("../src/lib/server/db/recover-owner"),
			import("../src/lib/server/db/runtime-installation"),
			import("../src/lib/server/services/owner/credentials"),
			import("../src/lib/server/services/owner/data-directory"),
		]);
	const installation = await openRuntimeInstallation(ownerDirectory(), process.env, "recovery");
	const raw = !!input.isRaw;
	const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
	let cancelled = false;
	const abort = () => {
		cancelled = true;
		input.emit("siluet:cancel");
	};
	const ensureActive = () => {
		if (cancelled) throw new Error("Recovery cancelled.");
	};
	const pending: string[] = [];
	let line = "",
		skipLf = false,
		listener: (() => void) | undefined;
	const receive = (chunk: string) => {
		for (const char of chunk) {
			if (char === "\u0003" || char === "\u0004") {
				abort();
				return;
			}
			if (char === "\n" && skipLf) {
				skipLf = false;
				continue;
			}
			skipLf = char === "\r";
			if (char === "\r" || char === "\n") {
				pending.push(line);
				line = "";
			} else if (char === "\b" || char === "\u007f") {
				line = Array.from(line).slice(0, -1).join("");
			} else line += char;
			if (Buffer.byteLength(line) > 1024 || pending.length > 2) {
				abort();
				return;
			}
		}
		listener?.();
	};
	async function prompt(label: string) {
		output.write(label);
		ensureActive();
		if (!pending.length)
			await new Promise<void>((resolve, reject) => {
				const cleanup = () => {
					listener = undefined;
					input.off("siluet:cancel", stop);
				};
				const stop = () => {
					cleanup();
					reject(new Error("Recovery cancelled."));
				};
				listener = () => {
					if (pending.length) {
						cleanup();
						resolve();
					}
				};
				input.once("siluet:cancel", stop);
			});
		ensureActive();
		output.write("\n");
		const value = pending.shift();
		if (value === undefined) throw new Error("Recovery cancelled.");
		return value;
	}
	try {
		for (const signal of signals) process.on(signal, abort);
		output.write("If forcibly terminated, type stty sane and press Enter to restore input echo.\n");
		input.setRawMode(true);
		input.setEncoding("utf8");
		input.on("data", receive);
		input.once("end", abort);
		const password = await prompt("New password: ");
		if (password !== (await prompt("Confirm password: ")))
			throw new Error("Passwords did not match.");
		const hash = await hashPassword(password);
		ensureActive();
		await recoverOwner(installation, hash, ensureActive);
		output.write("Access restored. Restart Siluet and sign in with your new password.\n");
	} finally {
		input.off("end", abort);
		input.off("data", receive);
		input.pause();
		try {
			input.setRawMode(raw);
		} finally {
			for (const signal of signals) process.off(signal, abort);
			await installation.close();
		}
	}
}
if (import.meta.main)
	main().catch((e) => {
		// Database and terminal errors can contain local paths and query arguments.
		const message = e instanceof Error ? e.message : "";
		const allowed = [
			"Studio recovery lock unavailable.",
			"Studio storage could not be verified.",
			"Start the installed version once",
			"Run recovery from an interactive terminal.",
			"Recovery cancelled.",
			"Passwords did not match.",
			"Use at least 15 characters",
			"An absolute data directory",
			"The data directory must be private.",
			"Another user could replace the data directory.",
		];
		console.error(
			e instanceof UnsupportedPlatformError
				? unsupportedPlatformMessage
				: allowed.some((prefix) => message.startsWith(prefix))
					? message
					: "Owner recovery could not finish. Verify the stopped installation and its backup.",
		);
		process.exitCode = 1;
	});
