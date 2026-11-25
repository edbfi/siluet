import { randomBytes } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, open, rename, rm } from "node:fs/promises";
import { join } from "node:path";

export const providerKeyFilename = "provider-credentials.key";
const keySize = 32;

export class ProviderKeyPolicyError extends Error {
	constructor() {
		super("Provider key storage must be a private directory and a regular, unlinked key file.");
	}
}

const isMissing = (error: unknown) =>
	error instanceof Error && "code" in error && error.code === "ENOENT";
const isPrivate = (entry: Stats) => entry.uid === process.getuid?.() && (entry.mode & 0o077) === 0;

async function inspect(directory: string, path: string) {
	try {
		const parent = await lstat(directory);
		if (!parent.isDirectory() || !isPrivate(parent)) throw new ProviderKeyPolicyError();
		const file = await lstat(path).catch((error: unknown) => {
			if (isMissing(error)) return null;
			throw error;
		});
		if (file && (!file.isFile() || file.nlink !== 1 || !isPrivate(file)))
			throw new ProviderKeyPolicyError();
		return { parent, file };
	} catch {
		throw new ProviderKeyPolicyError();
	}
}

type KeyEntries = Awaited<ReturnType<typeof inspect>>;

function sameEntry(a: Stats, b: Stats) {
	return a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.uid === b.uid;
}

function sameFile(a: Stats | null, b: Stats | null) {
	if (!a || !b) return a === b;
	return sameEntry(a, b) && a.nlink === b.nlink && a.size === b.size && a.ctimeMs === b.ctimeMs;
}

function sameEntries(a: KeyEntries, b: KeyEntries) {
	return sameEntry(a.parent, b.parent) && sameFile(a.file, b.file);
}

async function loadProviderKey(directory: string, path: string) {
	for (let attempt = 0; attempt < 2; attempt++) {
		const inspected = await inspect(directory, path);
		if (!sameEntries(inspected, await inspect(directory, path))) continue;
		if (!inspected.file || inspected.file.size !== keySize) return { inspected, key: null };

		try {
			// O_NONBLOCK: a FIFO swapped in after the checks opens at once and fails them.
			const file = await open(
				path,
				constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
			);
			try {
				if (!sameFile(inspected.file, await file.stat())) continue;
				const key = await file.readFile();
				if (key.length === keySize) return { inspected, key };
			} finally {
				await file.close();
			}
		} catch (error) {
			if (isMissing(error)) continue;
			throw new ProviderKeyPolicyError();
		}
	}
	throw new ProviderKeyPolicyError();
}

export async function readProviderKey(directory: string) {
	return (await loadProviderKey(directory, join(directory, providerKeyFilename))).key;
}

async function writeTemporaryKey(path: string, key: Buffer) {
	const file = await open(path, "wx", 0o600);
	try {
		await file.writeFile(key);
		await file.sync();
	} finally {
		await file.close();
	}
}

async function syncDirectory(directory: string) {
	const handle = await open(directory, "r");
	try {
		await handle.sync();
	} catch (error) {
		// Some filesystems do not implement directory fsync.
		if (
			!(error instanceof Error) ||
			!("code" in error) ||
			!(error.code === "EINVAL" || error.code === "ENOTSUP" || error.code === "EOPNOTSUPP")
		)
			throw error;
	} finally {
		await handle.close();
	}
}

// Inspect permissions and write a private candidate outside the database queue.
export async function prepareProviderKey(directory: string) {
	const path = join(directory, providerKeyFilename);
	const { inspected, key: current } = await loadProviderKey(directory, path);
	const key = current ?? randomBytes(keySize);
	let temporary: { path: string; file: Stats } | undefined;
	if (!current) {
		const temporaryPath = join(directory, `${providerKeyFilename}.${crypto.randomUUID()}.tmp`);
		try {
			await writeTemporaryKey(temporaryPath, key);
			const { file } = await inspect(directory, temporaryPath);
			if (file?.size !== keySize) throw new ProviderKeyPolicyError();
			temporary = { path: temporaryPath, file };
		} catch (error) {
			await rm(temporaryPath, { force: true });
			throw error;
		}
	}

	return {
		key,
		// Call inside an immediate database transaction. Another connection may
		// have published its own key since this one's permission check.
		async publishIfCurrent() {
			if (!sameEntries(inspected, await inspect(directory, path))) return false;
			if (temporary) {
				if (!sameFile(temporary.file, (await inspect(directory, temporary.path)).file))
					throw new ProviderKeyPolicyError();
				await rename(temporary.path, path);
				temporary = undefined;
				await syncDirectory(directory);
			}
			return true;
		},
		async discard() {
			if (temporary) await rm(temporary.path, { force: true });
		},
	};
}
