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

export async function preparePrivateDirectory(directory: string, existing = false) {
	requireSupportedPlatform();
	if (!isAbsolute(directory))
		throw new DirectoryPolicyError("An absolute data directory is required.");
	const checkout = dirname(createRequire(import.meta.url).resolve("#studio-manifest"));
	requireOutsideCheckout(checkout, directory);
	const realCheckout = await realpath(checkout);
	requireOutsideCheckout(realCheckout, await prospectivePath(directory));
	if (!existing) await mkdir(directory, { recursive: true, mode: 0o700 });
	const info = await lstat(directory);
	if (!info.isDirectory()) throw new DirectoryPolicyError("Expected a private directory.");
	requireOutsideCheckout(realCheckout, await realpath(directory));
	if (info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0)
		throw new DirectoryPolicyError("The data directory must be private.");
}
