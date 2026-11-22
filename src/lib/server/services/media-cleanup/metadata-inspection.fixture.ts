import { expect } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

export const exifTool = process.env.SILUET_TEST_EXIFTOOL;
// The Windows distribution bundles its own Perl next to exiftool.pl.
const perl = process.env.SILUET_TEST_PERL ?? "perl";

export async function inspectCleanup(
	extension: "jpg" | "png",
	source: Uint8Array,
	prepare: (bytes: Buffer) => Promise<Uint8Array>,
	verify: (inspect: (file: "source" | "cleaned", ...args: string[]) => Buffer) => void,
) {
	if (!exifTool || !isAbsolute(exifTool)) throw new Error("Set an absolute ExifTool script path");
	const version = Bun.spawnSync([perl, exifTool, "-ver"], { timeout: 5_000 });
	expect(version.exitCode).toBe(0);
	expect(version.stdout.toString().trim()).toBe("13.64");

	const directory = mkdtempSync(join(tmpdir(), "Siluet café "));
	const paths = {
		source: join(directory, `photo source 雪.${extension}`),
		cleaned: join(directory, `copie propre 雪.${extension}`),
	};
	try {
		writeFileSync(paths.source, source);
		const hash = createHash("sha256").update(source).digest("hex");
		writeFileSync(paths.cleaned, await prepare(readFileSync(paths.source)));
		verify((file, ...args) => {
			// Pass bytes via stdin. ExifTool's command line filename charset differs on Windows.
			const result = Bun.spawnSync([perl, exifTool, ...args, "-"], {
				stdin: readFileSync(paths[file]),
				timeout: 5_000,
			});
			expect(result.stderr.toString()).toBe("");
			expect(result.exitCode).toBe(0);
			return result.stdout;
		});
		expect(createHash("sha256").update(readFileSync(paths.source)).digest("hex")).toBe(hash);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}
