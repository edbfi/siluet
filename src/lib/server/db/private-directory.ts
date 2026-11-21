import { lstat, mkdir, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";

export class DirectoryPolicyError extends Error {}

// Windows mode bits do not expose NTFS permissions. Read the ACL by SID so
// localized account names and inherited grants are handled the same way.
async function verifyWindowsAcl(directory: string) {
	const systemRoot = process.env.SystemRoot;
	if (!systemRoot || !isAbsolute(systemRoot))
		throw new DirectoryPolicyError("Cannot locate Windows to verify data directory permissions.");
	const script = `
		$ErrorActionPreference = 'Stop'
		$sidType = [System.Security.Principal.SecurityIdentifier]
		$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
		$trusted = @($user, 'S-1-5-18', 'S-1-5-32-544')
		$root = [System.IO.DirectoryInfo]::new($env:SILUET_ACL_PATH)
		try { $entries = @($root) + $root.GetFileSystemInfos() } catch { exit 20 }
		foreach ($entry in $entries) {
			try { $acl = $entry.GetAccessControl() } catch { exit 21 }
			if ($acl.GetOwner($sidType).Value -notin $trusted) { exit 10 }
			$rules = $acl.GetAccessRules($true, $true, $sidType)
			if (!$rules.Count) { exit 11 }
			foreach ($rule in $rules) {
				if ($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Value -notin $trusted) { exit 12 }
			}
		}
		exit 0
	`;
	const child = Bun.spawn(
		[
			join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
			"-NoProfile",
			"-NonInteractive",
			"-EncodedCommand",
			Buffer.from(script, "utf16le").toString("base64"),
		],
		{
			env: { ...process.env, SILUET_ACL_PATH: directory },
			stdin: "ignore",
			stdout: "ignore",
			stderr: "ignore",
		},
	);
	switch (await child.exited) {
		case 0:
			return;
		case 10:
			throw new DirectoryPolicyError("The data directory must be private. Check ownership.");
		case 11:
			throw new DirectoryPolicyError(
				"The data directory must be private. No access rules were found.",
			);
		case 12:
			throw new DirectoryPolicyError(
				"The data directory must be private. Check grants to other accounts.",
			);
		case 20:
			throw new DirectoryPolicyError("Windows could not enumerate the private data directory.");
		case 21:
			throw new DirectoryPolicyError(
				"Windows could not read a data directory access control list.",
			);
		default:
			throw new DirectoryPolicyError("Windows could not read the data directory permissions.");
	}
}

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

export async function preparePrivateDirectory(directory: string) {
	if (!isAbsolute(directory))
		throw new DirectoryPolicyError("An absolute data directory is required.");
	const checkout = dirname(createRequire(import.meta.url).resolve("#studio-manifest"));
	requireOutsideCheckout(checkout, directory);
	const realCheckout = await realpath(checkout);
	requireOutsideCheckout(realCheckout, await prospectivePath(directory));
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const info = await lstat(directory);
	if (!info.isDirectory()) throw new DirectoryPolicyError("Expected a private directory.");
	requireOutsideCheckout(realCheckout, await realpath(directory));
	if (process.platform === "win32") {
		await verifyWindowsAcl(directory);
	} else if (info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) {
		throw new DirectoryPolicyError("The data directory must be private.");
	}
}
