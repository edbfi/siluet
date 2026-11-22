import { execFile } from "node:child_process";
import { constants, type Stats } from "node:fs";
import { lstat, open, unlink } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join } from "node:path";

export class KeyViolation extends Error {}
export const factorIdPattern =
	/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function keyPath(directory: string, id: string) {
	if (!factorIdPattern.test(id)) throw new KeyViolation();
	return join(directory, `factor-${id}.key`);
}
function verify(file: Stats) {
	if (
		!file.isFile() ||
		file.nlink !== 1 ||
		file.uid !== process.getuid?.() ||
		(file.mode & 0o077) !== 0
	)
		throw new KeyViolation();
}
async function privateParent(directory: string) {
	const parent = await lstat(directory);
	if (!parent.isDirectory() || parent.uid !== process.getuid?.() || (parent.mode & 0o077) !== 0)
		throw new KeyViolation();
}
async function helper(path: string, input?: Buffer) {
	const executable = join(
		dirname(createRequire(import.meta.url).resolve("#studio-manifest")),
		"build",
		"native",
		"FactorKey.exe",
	);
	return runFactorKeyProcess([executable, input ? "publish" : "read", path], input);
}
export function runFactorKeyProcess(
	[executable, ...args]: [string, ...string[]],
	input?: Buffer,
	timeout = 10000,
): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const unavailable = () => new Error("Key service unavailable.");
		if (!isAbsolute(executable) || (input && input.length !== 32)) {
			reject(unavailable());
			return;
		}
		let inputFailed = false;
		try {
			const child = execFile(
				executable,
				args,
				{
					encoding: "buffer",
					timeout,
					killSignal: "SIGKILL",
					maxBuffer: 64,
					windowsHide: true,
				},
				(error, stdout, stderr) => {
					if (
						error?.code === 10 &&
						!error.killed &&
						!error.signal &&
						!stdout.length &&
						!stderr.length
					) {
						reject(new KeyViolation());
					} else if (
						error ||
						inputFailed ||
						(input && !child.stdin?.writableFinished) ||
						stderr.length ||
						stdout.length !== (input ? 0 : 32)
					) {
						reject(unavailable());
					} else {
						resolve(stdout);
					}
				},
			);
			// A verified refusal can close stdin before reading the proposed key.
			// Let the bounded exit callback classify it, regardless of pipe-event ordering.
			const pipe = child.stdin;
			pipe?.on("error", () => {
				inputFailed = true;
			});
			try {
				pipe?.end(input);
			} catch {
				inputFailed = true;
				pipe?.destroy();
			}
		} catch {
			reject(unavailable());
		}
	});
}
export async function readFactorKey(directory: string, id: string) {
	const path = keyPath(directory, id);
	if (process.platform === "win32") return helper(path);
	try {
		await privateParent(directory);
		const observed = await lstat(path);
		verify(observed);
		const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		try {
			const info = await file.stat();
			verify(info);
			if (info.dev !== observed.dev || info.ino !== observed.ino || info.size !== 32)
				throw new KeyViolation();
			const key = Buffer.alloc(33);
			if ((await file.read(key, 0, 33, 0)).bytesRead !== 32) throw new KeyViolation();
			return key.subarray(0, 32);
		} finally {
			await file.close();
		}
	} catch (e) {
		if (e instanceof Error && "code" in e && (e.code === "ENOENT" || e.code === "ELOOP"))
			throw new KeyViolation();
		throw e;
	}
}
export async function publishFactorKey(
	directory: string,
	id: string,
	key: Buffer,
	checkpoint?: (stage: string) => void,
) {
	const path = keyPath(directory, id);
	if (key.length !== 32) throw new Error("Invalid key length.");
	if (process.platform === "win32") {
		await helper(path, key);
		return;
	}
	await privateParent(directory);
	checkpoint?.("before-create");
	const file = await open(path, "wx", 0o600);
	try {
		verify(await file.stat());
		checkpoint?.("created");
		await file.writeFile(key);
		checkpoint?.("written");
		await file.sync();
		checkpoint?.("flushed");
	} finally {
		await file.close();
	}
	checkpoint?.("closed");
	const parent = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY);
	try {
		await parent.sync();
		checkpoint?.("published");
	} finally {
		await parent.close();
	}
}
export async function retireFactorKey(directory: string, id: string) {
	// Only a successfully superseded key is eligible. Unknown and unsafe entries stay in place.
	await readFactorKey(directory, id);
	await unlink(keyPath(directory, id));
}

export async function cleanUnusedFactorKeys(
	directory: string,
	active: string | null,
	names: string[],
) {
	for (const name of names) {
		const temporary = process.platform === "win32" && name.endsWith(".key.tmp");
		if (!name.startsWith("factor-") || (!temporary && !name.endsWith(".key"))) continue;
		const id = name.slice(7, temporary ? -8 : -4);
		if (id === active || !factorIdPattern.test(id)) continue;
		if (temporary) {
			const path = join(directory, name);
			try {
				await helper(path);
				await unlink(path);
			} catch {
				/* Preserve incomplete or unverifiable files. */
			}
		} else await retireFactorKey(directory, id).catch(() => {});
	}
}
