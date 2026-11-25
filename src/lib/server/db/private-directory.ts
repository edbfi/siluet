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

const missing = (error: unknown) =>
	error instanceof Error && "code" in error && error.code === "ENOENT";

function lstatIfPresent(path: string) {
	return lstat(path).catch((error: unknown) => {
		if (missing(error)) return null;
		throw error;
	});
}

// Resolve even a not-yet-created path before making directories through an alias.
async function prospectivePath(directory: string): Promise<string> {
	try {
		return await realpath(directory);
	} catch (error) {
		if (!missing(error)) throw error;
		const parent = dirname(directory);
		if (parent === directory) throw error;
		return join(await prospectivePath(parent), basename(directory));
	}
}

const shellQuote = (path: string) =>
	/^[\w@%+=:,./-]+$/.test(path) ? path : `'${path.replaceAll("'", "'\\''")}'`;

// Shown in the terminal that starts the studio or runs recovery.
const replaceable = (folder: string, owned: boolean) =>
	new DirectoryPolicyError(
		owned
			? `Another user could replace the data directory through ${folder}. Run chmod g-w,o-w ${shellQuote(folder)}, or choose another data directory.`
			: `Another user could replace the data directory through ${folder}, which belongs to another user. Choose another data directory.`,
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
export async function requireStableFolder(
	folder: string,
	info: Folder,
	readAccounts: ReadLocalAccounts,
) {
	if (!info.isDirectory())
		throw new DirectoryPolicyError(
			`The data directory cannot pass through ${folder}, which is not a folder. Choose another data directory.`,
		);
	if (info.uid !== 0 && info.uid !== process.getuid?.()) throw replaceable(folder, false);
	if (info.mode & 0o1000) return;
	if (info.mode & 0o002 || (info.mode & 0o020 && !(await privateGroupFolder(info, readAccounts))))
		throw replaceable(folder, true);
}

/**
 * Refuse a path that another user could redirect through a folder or link it
 * passes. A link only needs a trusted owner (macOS /var and /tmp are root's);
 * the folder holding it and its target's folders are checked in turn.
 */
async function requireStablePath(path: string, readAccounts: ReadLocalAccounts) {
	for (let entry = path; ; entry = dirname(entry)) {
		// Folders that do not exist yet are created private.
		const info = await lstatIfPresent(entry);
		if (info?.isSymbolicLink()) {
			if (info.uid !== 0 && info.uid !== process.getuid?.()) throw replaceable(entry, false);
		} else if (info && entry !== path) await requireStableFolder(entry, info, readAccounts);
		if (dirname(entry) === entry) return;
	}
}

// Create each missing folder alone and check it before creating the next one in it.
async function createPrivatePath(path: string, readAccounts: ReadLocalAccounts) {
	const absent: string[] = [];
	for (let folder = path; !(await lstatIfPresent(folder)); folder = dirname(folder))
		absent.unshift(folder);
	for (const folder of absent) {
		await mkdir(folder, { mode: 0o700 }).catch((error: unknown) => {
			if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
		});
		await requireStableFolder(folder, await lstat(folder), readAccounts);
	}
}

/**
 * Check, create if needed and return the canonical data directory. The studio
 * uses only the returned path, so a link cannot redirect it after these checks.
 */
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
	const canonical = await prospectivePath(directory);
	requireOutsideCheckout(await realpath(checkout), canonical);
	await requireStablePath(directory, readAccounts);
	await requireStablePath(canonical, readAccounts);
	if (!existing) await createPrivatePath(canonical, readAccounts);
	const info = await lstat(canonical);
	if (!info.isDirectory()) throw new DirectoryPolicyError("Expected a private directory.");
	if (info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0)
		throw new DirectoryPolicyError("The data directory must be private.");
	return canonical;
}
