import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32 } from "node:zlib";
import sharp from "sharp";

// Gallery images at G13's bounds (catalog engine spec, "Gallery size limits"), generated with
// sharp into a private temporary directory and never committed. Seeded xorshift noise is the
// worst case for each encoder; the low-entropy fixtures stay small enough to reach verification.
// Generation takes several seconds, so a caller's hooks and tests pass an explicit timeout.

const MiB = 1024 * 1024;

/** The bounds G13 sets: 20 MP saves, up to 25 MP is classified, and 80 MiB is read. */
export const g13Bounds = {
	pixels: 20_000_000,
	verificationPixels: 25_000_000,
	bytes: 80 * MiB,
} as const;

/** Seeded xorshift32 bytes, each masked to `mask` (255 for full noise). */
export function noise(length: number, seed: number, mask = 255) {
	const bytes = new Uint8Array(length);
	let x = seed >>> 0 || 1;
	for (let i = 0; i < length; i++) {
		x ^= x << 13;
		x >>>= 0;
		x ^= x >>> 17;
		x ^= x << 5;
		x >>>= 0;
		bytes[i] = x & mask;
	}
	return bytes;
}

const raw = (width: number, height: number, channels: 1 | 3 | 4, seed: number, mask = 255) =>
	sharp(noise(width * height * channels, seed, mask), { raw: { width, height, channels } });

// Two bits of noise per channel, deflated fast: within the encoded bound, unlike full noise.
const lowEntropyPng = (width: number, height: number, seed: number) =>
	raw(width, height, 3, seed, 3).png({ compressionLevel: 1 }).toBuffer();

function gradient16(width: number, height: number) {
	const pixels = new Uint16Array(width * height * 3);
	for (let y = 0; y < height; y++)
		for (let x = 0; x < width; x++) {
			const i = (y * width + x) * 3;
			pixels[i] = (x * 13 + (y & 255)) & 0xffff;
			pixels[i + 1] = (y * 16) & 0xffff;
			pixels[i + 2] = (x * y) & 0xffff;
		}
	return sharp(pixels, { raw: { width, height, channels: 3 } })
		.toColourspace("rgb16")
		.png({ adaptiveFiltering: true })
		.toBuffer();
}

/** `png` with a private ancillary `siLu` chunk after `IHDR`, so the file is `size` bytes. */
export function padPng(png: Buffer, size: number) {
	const ihdrEnd = 8 + 8 + png.readUInt32BE(8) + 4;
	const padding = size - png.length - 12;
	if (padding < 0) throw new Error("The PNG is already larger than the padded size.");
	const data = Buffer.alloc(padding, 0x53);
	const chunk = Buffer.alloc(12 + data.length);
	chunk.writeUInt32BE(data.length, 0);
	chunk.write("siLu", 4, "latin1");
	data.copy(chunk, 8);
	chunk.writeUInt32BE(crc32(chunk.subarray(4, 8 + data.length)), 8 + data.length);
	return Buffer.concat([png.subarray(0, ihdrEnd), chunk, png.subarray(ihdrEnd)]);
}

type Spec = {
	width: number;
	height: number;
	mime: "image/png" | "image/jpeg" | "image/webp";
	make: () => Promise<Buffer>;
};

const paddedBase = () => lowEntropyPng(1000, 1000, 11);

const specs = {
	/** 5000×4000 stored 8-bit RGBA PNG: the encoded-size basis for 80 MiB. */
	png20: {
		width: 5000,
		height: 4000,
		mime: "image/png",
		make: () =>
			raw(5000, 4000, 4, 1).png({ compressionLevel: 0, adaptiveFiltering: false }).toBuffer(),
	},
	/** 5000×4000 q100 4:4:4 JPEG. */
	jpeg20: {
		width: 5000,
		height: 4000,
		mime: "image/jpeg",
		make: () => raw(5000, 4000, 3, 2).jpeg({ quality: 100, chromaSubsampling: "4:4:4" }).toBuffer(),
	},
	/** 5000×4000 lossless RGBA WebP, the costliest decode. */
	webp20: {
		width: 5000,
		height: 4000,
		mime: "image/webp",
		make: () => raw(5000, 4000, 4, 3).webp({ lossless: true, effort: 0 }).toBuffer(),
	},
	/** 5000×4000 compressible 16-bit RGB PNG. */
	png16: { width: 5000, height: 4000, mime: "image/png", make: () => gradient16(5000, 4000) },
	/** `flux-3-klein` `4K`: a 4096 px long edge at 1:1. */
	flux4k: {
		width: 4096,
		height: 4096,
		mime: "image/png",
		make: () => lowEntropyPng(4096, 4096, 4),
	},
	/** Exactly the encoded bound. */
	encodedBound: {
		width: 1000,
		height: 1000,
		mime: "image/png",
		make: async () => padPng(await paddedBase(), g13Bounds.bytes),
	},
	/** One byte over the encoded bound. */
	overEncoded: {
		width: 1000,
		height: 1000,
		mime: "image/png",
		make: async () => padPng(await paddedBase(), g13Bounds.bytes + 1),
	},
	/** One row over 20 MP. */
	over20: {
		width: 5000,
		height: 4001,
		mime: "image/png",
		make: () => lowEntropyPng(5000, 4001, 5),
	},
	/** Exactly the 25 MP classification bound. */
	verification25: {
		width: 5000,
		height: 5000,
		mime: "image/png",
		make: () => lowEntropyPng(5000, 5000, 6),
	},
	/** One row over the classification bound. */
	over25: {
		width: 5000,
		height: 5001,
		mime: "image/png",
		make: () => lowEntropyPng(5000, 5001, 7),
	},
	/** 16 MP, within today's 32 MiB. */
	current: {
		width: 4000,
		height: 4000,
		mime: "image/png",
		make: () => lowEntropyPng(4000, 4000, 8),
	},
	/** D7's worst case: a high-entropy 4000×4000 JPEG within 16 MiB, rotated by EXIF. */
	cleanupJpeg: {
		width: 4000,
		height: 4000,
		mime: "image/jpeg",
		make: () =>
			raw(4000, 4000, 3, 9)
				.jpeg({ quality: 70, chromaSubsampling: "4:4:4" })
				.withMetadata({ orientation: 6 })
				.toBuffer(),
	},
} satisfies Record<string, Spec>;

export type GalleryFixtureName = keyof typeof specs;
export const galleryFixtureNames = Object.keys(specs) as GalleryFixtureName[];

export type GalleryFixture = {
	path: string;
	width: number;
	height: number;
	mime: Spec["mime"];
	size: number;
	sha256: string;
};

export type GalleryBounds<N extends GalleryFixtureName> = {
	directory: string;
	files: Record<N, GalleryFixture>;
	remove: () => Promise<void>;
};

/** Generate the named fixtures, one at a time, into a new temporary directory. */
export async function generateGalleryBounds<N extends GalleryFixtureName>(
	names: readonly N[],
): Promise<GalleryBounds<N>> {
	const directory = await mkdtemp(join(tmpdir(), "siluet-gallery-bounds-"));
	const files = {} as Record<N, GalleryFixture>;
	try {
		for (const name of names) {
			const { width, height, mime, make } = specs[name];
			const bytes = await make();
			const path = join(directory, name);
			await writeFile(path, bytes, { mode: 0o600 });
			const sha256 = createHash("sha256").update(bytes).digest("hex");
			files[name] = { path, width, height, mime, size: bytes.length, sha256 };
		}
	} catch (error) {
		await rm(directory, { recursive: true, force: true });
		throw error;
	}
	return { directory, files, remove: () => rm(directory, { recursive: true, force: true }) };
}
