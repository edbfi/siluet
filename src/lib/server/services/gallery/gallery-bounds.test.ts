import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { dirname } from "node:path";
import sharp from "sharp";
import {
	type GalleryBounds,
	type GalleryFixtureName,
	g13Bounds,
	galleryFixtureNames,
	generateGalleryBounds,
	noise,
} from "../../../../../tests/fixtures/gallery-bounds";

// The generated bound fixtures (tests/fixtures/gallery-bounds.ts) are what the verifier, budget
// and browser tests rely on: these checks keep their sizes, dimensions and formats honest.

const formats = { "image/png": "png", "image/jpeg": "jpeg", "image/webp": "webp" } as const;
let bounds: GalleryBounds<GalleryFixtureName>;

beforeAll(async () => {
	bounds = await generateGalleryBounds(galleryFixtureNames);
}, 60_000);

afterAll(() => bounds?.remove(), 60_000);

test("the same seed yields the same noise, and another seed does not", () => {
	const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
	expect(digest(noise(1 << 20, 1))).toBe(digest(noise(1 << 20, 1)));
	expect(digest(noise(1 << 20, 1))).not.toBe(digest(noise(1 << 20, 2)));
	expect(Math.max(...noise(4096, 3, 3))).toBe(3);
});

test("a regenerated fixture has the same SHA-256 and length", async () => {
	const again = await generateGalleryBounds(["current", "encodedBound"]);
	try {
		for (const name of ["current", "encodedBound"] as const) {
			expect(again.files[name].sha256).toBe(bounds.files[name].sha256);
			expect(again.files[name].size).toBe(bounds.files[name].size);
		}
	} finally {
		await again.remove();
	}
}, 60_000);

test("every fixture lands in the temporary directory, and its record matches the file", async () => {
	expect(bounds.directory).toContain("siluet-gallery-bounds-");
	for (const name of galleryFixtureNames) {
		const file = bounds.files[name];
		expect(dirname(file.path)).toBe(bounds.directory);
		const bytes = await readFile(file.path);
		expect(bytes.length).toBe(file.size);
		expect(createHash("sha256").update(bytes).digest("hex")).toBe(file.sha256);
		const { width, height, format } = await sharp(bytes).metadata();
		expect({ name, width, height, format }).toEqual({
			name,
			width: file.width,
			height: file.height,
			format: formats[file.mime],
		});
	}
}, 60_000);

test("the 20 MP fixtures sit at the pixel bound and within the encoded bound", async () => {
	for (const name of ["png20", "jpeg20", "webp20", "png16"] as const) {
		const file = bounds.files[name];
		expect(file.width * file.height).toBe(g13Bounds.pixels);
		expect(file.size).toBeLessThanOrEqual(g13Bounds.bytes);
	}
	// The stored RGBA PNG is the basis for the encoded bound.
	expect(bounds.files.png20.size).toBeGreaterThan(80_000_000);
	const png16 = await sharp(bounds.files.png16.path).metadata();
	expect(png16.depth).toBe("ushort");
	expect(bounds.files.flux4k.width * bounds.files.flux4k.height).toBe(16_777_216);
}, 60_000);

test("the padded PNGs are exactly the encoded bound and one byte over it", () => {
	expect(bounds.files.encodedBound.size).toBe(83_886_080);
	expect(bounds.files.overEncoded.size).toBe(83_886_081);
});

test("the hold fixtures straddle 20 MP and 25 MP and stay within the encoded bound", () => {
	const { over20, verification25, over25 } = bounds.files;
	expect(over20.width * over20.height).toBe(g13Bounds.pixels + 5000);
	expect(verification25.width * verification25.height).toBe(g13Bounds.verificationPixels);
	expect(over25.width * over25.height).toBe(g13Bounds.verificationPixels + 5000);
	for (const file of [over20, verification25, over25])
		expect(file.size).toBeLessThanOrEqual(g13Bounds.bytes);
});

test("the current-bound and D7 fixtures stay within today's 32 MiB and cleanup's 16 MiB", async () => {
	expect(bounds.files.current.width * bounds.files.current.height).toBe(16_000_000);
	expect(bounds.files.current.size).toBeLessThanOrEqual(32 * 1024 * 1024);
	expect(bounds.files.cleanupJpeg.size).toBeLessThanOrEqual(16 * 1024 * 1024);
	expect((await sharp(bounds.files.cleanupJpeg.path).metadata()).orientation).toBe(6);
}, 60_000);

test("removing the fixtures deletes their directory", async () => {
	const set = await generateGalleryBounds(["current"]);
	await set.remove();
	expect(stat(set.directory)).rejects.toMatchObject({ code: "ENOENT" });
}, 60_000);
