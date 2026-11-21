import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function createOwnerDirectory() {
	const directory = await mkdtemp(join(tmpdir(), "siluet-owner-"));
	if (process.platform === "win32") {
		// mkdtemp inherits the runner's temp ACL. Give this empty fixture and its
		// children the permissions expected of a private owner installation.
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
