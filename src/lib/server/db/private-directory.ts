import { lstat, mkdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";

// Windows mode bits do not expose NTFS permissions. Read the ACL by SID so
// localized account names and inherited grants are handled the same way.
async function privateWindowsAcl(directory: string) {
	const systemRoot = process.env.SystemRoot;
	if (!systemRoot || !isAbsolute(systemRoot)) return false;
	const script = `
		$ErrorActionPreference = 'Stop'
		$sidType = [System.Security.Principal.SecurityIdentifier]
		$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
		$trusted = @($user, 'S-1-5-18', 'S-1-5-32-544')
		$paths = @($env:SILUET_ACL_PATH) + @(Get-ChildItem -Force -LiteralPath $env:SILUET_ACL_PATH | ForEach-Object { $_.FullName })
		foreach ($path in $paths) {
			$acl = Get-Acl -LiteralPath $path
			if ($acl.GetOwner($sidType).Value -notin $trusted) { exit 1 }
			$rules = $acl.GetAccessRules($true, $true, $sidType)
			if (!$rules.Count) { exit 1 }
			foreach ($rule in $rules) {
				if ($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Value -notin $trusted) { exit 1 }
			}
		}
		exit 0
	`;
	const child = Bun.spawn(
		[
			join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
			"-NoProfile",
			"-NonInteractive",
			"-Command",
			script,
		],
		{
			env: { ...process.env, SILUET_ACL_PATH: directory },
			stdin: "ignore",
			stdout: "ignore",
			stderr: "ignore",
		},
	);
	return (await child.exited) === 0;
}

export async function preparePrivateDirectory(directory: string) {
	if (!isAbsolute(directory)) throw new Error("An absolute data directory is required.");
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const info = await lstat(directory);
	if (!info.isDirectory()) throw new Error("Expected a private directory.");
	const fromStudio = relative(await realpath(process.cwd()), await realpath(directory));
	if (!isAbsolute(fromStudio) && fromStudio !== ".." && !fromStudio.startsWith(`..${sep}`))
		throw new Error("Choose a data directory outside the studio files.");
	const privateAccess =
		process.platform === "win32"
			? await privateWindowsAcl(directory)
			: info.uid === process.getuid?.() && (info.mode & 0o077) === 0;
	if (!privateAccess) throw new Error("The data directory must be private.");
}
