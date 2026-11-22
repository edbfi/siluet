// SPDX-License-Identifier: AGPL-3.0-or-later
// Provision the pinned ExifTool 13.64 for independent inspection in CI. Prints
// SILUET_TEST_EXIFTOOL and, on Windows, SILUET_TEST_PERL as environment lines.
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const windows = process.platform === "win32";
// Digests of the upstream release artifacts, checked 2026-11-22. The Windows build
// is published only on SourceForge. Its project-file URL redirects straight to a
// mirror, unlike the /download page, which can answer with an HTML interstitial.
const artifact = windows
	? {
			url: "https://downloads.sourceforge.net/project/exiftool/exiftool-13.64_64.zip",
			sha256: "72c29c44d1e860eebcaefa71692d979af9858fe9a6d7d791a5e7f1dac77804af",
			name: "exiftool.zip",
		}
	: {
			url: "https://codeload.github.com/exiftool/exiftool/tar.gz/refs/tags/13.64",
			sha256: "6ed24bfbe1ce38d0e7800f8e4132f9bfce2a29f4256d924d0458f59fd64b513a",
			name: "exiftool.tar.gz",
		};

// A mirror can fail or serve the wrong bytes. Retry a few times, then report each attempt.
async function download() {
	const failures: string[] = [];
	for (const delay of [0, 5_000, 15_000]) {
		if (delay) await Bun.sleep(delay);
		try {
			const response = await fetch(artifact.url, { signal: AbortSignal.timeout(120_000) });
			if (!response.ok)
				throw new Error(`HTTP ${response.status} from ${new URL(response.url).host}`);
			const archive = new Uint8Array(await response.arrayBuffer());
			if (createHash("sha256").update(archive).digest("hex") !== artifact.sha256)
				throw new Error(`SHA-256 mismatch from ${new URL(response.url).host}`);
			return archive;
		} catch (error) {
			failures.push(error instanceof Error ? error.message : String(error));
		}
	}
	throw new Error(`ExifTool download failed: ${failures.join("; ")}`);
}

const directory = mkdtempSync(join(tmpdir(), "siluet-exiftool-"));
await Bun.write(join(directory, artifact.name), await download());
// Git Bash puts GNU tar, which cannot read zip files, ahead of Windows' bsdtar on
// PATH. Call bsdtar by its system path there. macOS bsdtar and GNU tar on Linux
// unpack the tarball.
const tar = windows ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar";
const unpacked = Bun.spawnSync([tar, "-xf", artifact.name], { cwd: directory, stderr: "pipe" });
if (!unpacked.success)
	throw new Error(
		`ExifTool archive could not be unpacked by ${tar}: ${unpacked.stderr.toString().trim()}`,
	);

const lines = windows
	? [
			`SILUET_TEST_EXIFTOOL=${join(directory, "exiftool-13.64_64", "exiftool_files", "exiftool.pl")}`,
			`SILUET_TEST_PERL=${join(directory, "exiftool-13.64_64", "exiftool_files", "perl.exe")}`,
		]
	: [`SILUET_TEST_EXIFTOOL=${join(directory, "exiftool-13.64", "exiftool")}`];
console.log(lines.join("\n"));
