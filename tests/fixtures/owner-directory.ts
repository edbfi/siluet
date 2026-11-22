import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function createOwnerDirectory(prefix = "siluet-owner-") {
	const directory = await mkdtemp(join(tmpdir(), prefix));
	if (process.platform === "win32") {
		// Make this fixture private regardless of permissions inherited from the temp directory.
		try {
			execFileSync(
				"powershell.exe",
				[
					"-NoProfile",
					"-NonInteractive",
					"-Command",
					`$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
				icacls.exe $env:SILUET_TEST_DIRECTORY /inheritancelevel:r /grant:r ('*' + $sid + ':(OI)(CI)F')
				exit $LASTEXITCODE`,
				],
				{ env: { ...process.env, SILUET_TEST_DIRECTORY: directory } },
			);
		} catch (error) {
			await rm(directory, { recursive: true, force: true });
			throw error;
		}
	}
	return directory;
}
