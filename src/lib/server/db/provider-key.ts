import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { preparePrivateDirectory } from "./private-directory";

export const providerKeyFilename = "provider-credentials.key";
const keySize = 32;

async function readPrivateKey(path: string) {
	// The directory policy limits mutations to the owner. Refuse linked keys.
	const info = await lstat(path).catch((error: unknown) => {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
		throw error;
	});
	if (!info) return null;
	if (
		!info.isFile() ||
		info.nlink !== 1 ||
		(process.platform !== "win32" && (info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0))
	) {
		throw new Error("The provider encryption key must be a private regular file.");
	}
	if (info.size !== keySize) return null;
	const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
	try {
		const key = await file.readFile();
		return key.length === keySize ? key : null;
	} finally {
		await file.close();
	}
}

export async function readProviderKey(directory: string) {
	if (process.platform === "win32") await preparePrivateDirectory(directory);
	return readPrivateKey(join(directory, providerKeyFilename));
}

// Call inside an immediate installation transaction to serialize key publication
// and credential replacement, including replacements from another connection.
export async function ensureProviderKey(directory: string) {
	const existing = await readProviderKey(directory);
	if (existing) return existing;

	const key = randomBytes(keySize);
	const temporary = join(directory, `${providerKeyFilename}.${crypto.randomUUID()}.tmp`);
	const file = await open(temporary, "wx", 0o600);
	try {
		try {
			await file.writeFile(key);
			await file.sync();
		} finally {
			await file.close();
		}
		await rename(temporary, join(directory, providerKeyFilename));
	} finally {
		await rm(temporary, { force: true });
	}
	return key;
}
