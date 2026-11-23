import { constants, type Stats } from "node:fs";
import { lstat, open, unlink } from "node:fs/promises";
import { join } from "node:path";

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
export async function readFactorKey(directory: string, id: string) {
	const path = keyPath(directory, id);
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
		if (!name.startsWith("factor-") || !name.endsWith(".key")) continue;
		const id = name.slice(7, -4);
		if (id === active || !factorIdPattern.test(id)) continue;
		await retireFactorKey(directory, id).catch(() => {});
	}
}
