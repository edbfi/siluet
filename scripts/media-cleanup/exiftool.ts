// SPDX-License-Identifier: AGPL-3.0-or-later
// Provision the pinned ExifTool 13.64 for independent inspection in CI. Prints
// SILUET_TEST_EXIFTOOL and, on Windows, SILUET_TEST_PERL as environment lines.
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const windows = process.platform === "win32";
// Digests of the upstream release artifacts, checked 2026-11-22.
const artifact = windows
	? {
			url: "https://sourceforge.net/projects/exiftool/files/exiftool-13.64_64.zip/download",
			sha256: "72c29c44d1e860eebcaefa71692d979af9858fe9a6d7d791a5e7f1dac77804af",
			name: "exiftool.zip",
		}
	: {
			url: "https://codeload.github.com/exiftool/exiftool/tar.gz/refs/tags/13.64",
			sha256: "6ed24bfbe1ce38d0e7800f8e4132f9bfce2a29f4256d924d0458f59fd64b513a",
			name: "exiftool.tar.gz",
		};

const directory = mkdtempSync(join(tmpdir(), "siluet-exiftool-"));
const response = await fetch(artifact.url, { signal: AbortSignal.timeout(120_000) });
if (!response.ok) throw new Error(`ExifTool download returned HTTP ${response.status}`);
const archive = new Uint8Array(await response.arrayBuffer());
if (createHash("sha256").update(archive).digest("hex") !== artifact.sha256)
	throw new Error("ExifTool archive failed SHA-256 verification");
await Bun.write(join(directory, artifact.name), archive);
// bsdtar on Windows and macOS and GNU tar on Linux unpack both formats.
const unpacked = Bun.spawnSync(["tar", "-xf", artifact.name], { cwd: directory });
if (!unpacked.success) throw new Error("ExifTool archive could not be unpacked");

const lines = windows
	? [
			`SILUET_TEST_EXIFTOOL=${join(directory, "exiftool-13.64_64", "exiftool_files", "exiftool.pl")}`,
			`SILUET_TEST_PERL=${join(directory, "exiftool-13.64_64", "exiftool_files", "perl.exe")}`,
		]
	: [`SILUET_TEST_EXIFTOOL=${join(directory, "exiftool-13.64", "exiftool")}`];
console.log(lines.join("\n"));
