import { lstat, mkdir, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { userInfo } from "node:os";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { requireSupportedPlatform } from "../platform";
import { isUserPrivateGroup, type ReadLocalAccounts, readLocalAccounts } from "./private-group";

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

const replaceable = () =>
	new DirectoryPolicyError(
		"Another user could replace the data directory. Make its parent folders writable only by you, or choose another data directory.",
	);

type Folder = { uid: number; gid: number; mode: number; isDirectory(): boolean };

// Group write is safe when the group is this user's private group (Debian, Fedora).
// macOS folders belong to the shared `staff` group, so this never matches there.
async function privateGroupFolder(info: Folder, readAccounts: ReadLocalAccounts) {
	const uid = process.getuid?.();
	const gid = process.getgid?.();
	if (uid === undefined || uid === 0 || info.uid !== uid || info.gid !== gid) return false;
	try {
		return isUserPrivateGroup(await readAccounts(), { name: userInfo().username, uid, gid });
	} catch {
		return false;
	}
}

/**
 * A folder is stable when it belongs to root or this user and only its owner can
 * write it, unless it is sticky or only this user's private group can also write.
 */
export async function requireStableFolder(info: Folder, readAccounts: ReadLocalAccounts) {
	if (!info.isDirectory() || (info.uid !== 0 && info.uid !== process.getuid?.()))
		throw replaceable();
	if (info.mode & 0o1000) return;
	if (info.mode & 0o002) throw replaceable();
	if (info.mode & 0o020 && !(await privateGroupFolder(info, readAccounts))) throw replaceable();
}

/** Refuse a directory that another user could swap out through any folder above it. */
async function requireStableAncestors(directory: string, readAccounts: ReadLocalAccounts) {
	for (let folder = dirname(directory); ; folder = dirname(folder)) {
		// Folders that do not exist yet are created private.
		const info = await lstat(folder).catch((error: unknown) => {
			if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
			throw error;
		});
		if (info) await requireStableFolder(info, readAccounts);
		if (dirname(folder) === folder) return;
	}
}

export async function preparePrivateDirectory(
	directory: string,
	existing = false,
	readAccounts: ReadLocalAccounts = readLocalAccounts,
) {
	requireSupportedPlatform();
	if (!isAbsolute(directory))
		throw new DirectoryPolicyError("An absolute data directory is required.");
	const checkout = dirname(createRequire(import.meta.url).resolve("#studio-manifest"));
	requireOutsideCheckout(checkout, directory);
	const realCheckout = await realpath(checkout);
	const prospective = await prospectivePath(directory);
	requireOutsideCheckout(realCheckout, prospective);
	await requireStableAncestors(prospective, readAccounts);
	if (!existing) await mkdir(directory, { recursive: true, mode: 0o700 });
	const info = await lstat(directory);
	if (!info.isDirectory()) throw new DirectoryPolicyError("Expected a private directory.");
	const resolved = await realpath(directory);
	requireOutsideCheckout(realCheckout, resolved);
	// The resolved path has no links, so its folders are the ones the studio relies on.
	await requireStableAncestors(resolved, readAccounts);
	if (info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0)
		throw new DirectoryPolicyError("The data directory must be private.");
}
