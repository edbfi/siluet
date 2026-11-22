import { join } from "node:path";
export function consoleMode(restore?: number) {
	const executable = join(import.meta.dir, "..", "build", "native", "ConsoleMode.exe");
	const result = Bun.spawnSync(
		restore === undefined ? [executable] : [executable, String(restore)],
		{ stdin: "inherit", stdout: "pipe", stderr: "ignore", timeout: 5000, maxBuffer: 64 },
	);
	if (result.exitCode !== 0) throw new Error("Terminal mode unavailable.");
	if (restore !== undefined) return restore;
	const value = result.stdout.toString("ascii").trim();
	if (!/^[0-9]{1,10}$/.test(value)) throw new Error("Terminal mode unavailable.");
	return Number(value);
}
