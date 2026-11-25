import { lstat, mkdir, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { requireSupportedPlatform } from "../platform";

export class DirectoryPolicyError extends Error {}

function requireOutsideCheckout(checkout: string, directory: string) {
	const fromStudio = relative(checkout, directory);
	if (!isAbsolute(fromStudio) && fromStudio !== ".." && !fromStudio.startsWith(`..${sep}`))
		throw new DirectoryPolicyError("Choose a data directory outside the studio files.");
}

// Resolve even a not-yet-created path before making directories through an alias.
async function prospectivePath(directory: string): Promise<string> {
	try {
		return await realpath(directory);
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
		const parent = dirname(directory);
		if (parent === directory) throw error;
		return join(await prospectivePath(parent), basename(directory));
	}
}

/**
 * Refuse a directory that another user could swap out: every folder above it must
 * belong to root or this user, and be writable only by its owner unless it is sticky.
 */
async function requireStableAncestors(directory: string) {
	const uid = process.getuid?.();
	for (let folder = dirname(directory); ; folder = dirname(folder)) {
		// Folders that do not exist yet are created private.
		const info = await lstat(folder).catch((error: unknown) => {
			if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
			throw error;
		});
		const sharedWrite = info && (info.mode & 0o022) !== 0 && (info.mode & 0o1000) === 0;
		if (info && (!info.isDirectory() || (info.uid !== 0 && info.uid !== uid) || sharedWrite))
			throw new DirectoryPolicyError(
				"Another user could replace the data directory. Make its parent folders writable only by you, or choose another data directory.",
			);
		if (dirname(folder) === folder) return;
	}
}

export async function preparePrivateDirectory(directory: string, existing = false) {
	requireSupportedPlatform();
	if (!isAbsolute(directory))
		throw new DirectoryPolicyError("An absolute data directory is required.");
	const checkout = dirname(createRequire(import.meta.url).resolve("#studio-manifest"));
	requireOutsideCheckout(checkout, directory);
	const realCheckout = await realpath(checkout);
	const prospective = await prospectivePath(directory);
	requireOutsideCheckout(realCheckout, prospective);
	await requireStableAncestors(prospective);
	if (!existing) await mkdir(directory, { recursive: true, mode: 0o700 });
	const info = await lstat(directory);
	if (!info.isDirectory()) throw new DirectoryPolicyError("Expected a private directory.");
	const resolved = await realpath(directory);
	requireOutsideCheckout(realCheckout, resolved);
	// The resolved path has no links, so its folders are the ones the studio relies on.
	await requireStableAncestors(resolved);
	if (info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0)
		throw new DirectoryPolicyError("The data directory must be private.");
}
