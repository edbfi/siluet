import sharp from "sharp";

// WebP fixtures authored with sharp, then re-chunked to exercise Gallery's RIFF walk.
// Container layout: https://developers.google.com/speed/webp/docs/riff_container

export type WebpChunk = { type: string; data: Buffer };

/** The chunks of a well-formed WebP, in file order. */
export function webpChunks(file: Buffer): WebpChunk[] {
	const chunks: WebpChunk[] = [];
	for (let offset = 12; offset < file.length; ) {
		const size = file.readUInt32LE(offset + 4);
		const type = file.toString("latin1", offset, offset + 4);
		chunks.push({ type, data: file.subarray(offset + 8, offset + 8 + size) });
		offset += 8 + size + (size & 1);
	}
	return chunks;
}

/** A RIFF WebP from chunks. Each odd chunk gets `pad` as its pad byte. */
export function riffWebp(chunks: readonly WebpChunk[], pad = 0) {
	const parts = chunks.flatMap(({ type, data }) => {
		const header = Buffer.alloc(8);
		header.write(type, 0, "latin1");
		header.writeUInt32LE(data.length, 4);
		return data.length & 1 ? [header, data, Buffer.from([pad])] : [header, data];
	});
	const body = Buffer.concat(parts);
	const head = Buffer.alloc(12);
	head.write("RIFF", 0, "latin1");
	head.writeUInt32LE(body.length + 4, 4);
	head.write("WEBP", 8, "latin1");
	return Buffer.concat([head, body]);
}

export const vp8xFlags = { icc: 0x20, alpha: 0x10, exif: 0x08, xmp: 0x04, animation: 0x02 };

/** `file` less its last `count` bytes, with the RIFF size rewritten to match. */
export function shortened(file: Buffer, count: number) {
	const cut = Buffer.from(file.subarray(0, -count));
	cut.writeUInt32LE(cut.length - 8, 4);
	return cut;
}

/** `file` with its RIFF size field set to `size`. */
function riffSize(file: Buffer, size: number) {
	const copy = Buffer.from(file);
	copy.writeUInt32LE(size, 4);
	return copy;
}

/** `file` followed by a `type` chunk header whose size runs past the end, inside the RIFF size. */
function overrun(file: Buffer, type = "ABCD") {
	const header = Buffer.alloc(8);
	header.write(type, 0, "latin1");
	header.writeUInt32LE(1024, 4);
	return riffSize(Buffer.concat([file, header]), file.length);
}

/** `header` with a non-zero byte in the reserved bits after its flags. */
function reserved(header: WebpChunk): WebpChunk {
	const data = Buffer.from(header.data);
	data[2] = 1;
	return { type: header.type, data };
}

/** An extended-format header chunk with `flags` and a canvas of `width` × `height`. */
export function vp8x(flags: number, width: number, height: number): WebpChunk {
	const data = Buffer.alloc(10);
	data[0] = flags;
	data.writeUIntLE(width - 1, 4, 3);
	data.writeUIntLE(height - 1, 7, 3);
	return { type: "VP8X", data };
}

const chunk = (type: string, data: Buffer | string): WebpChunk => ({
	type,
	data: typeof data === "string" ? Buffer.from(data, "latin1") : data,
});
const only = (file: Buffer, type: string) => {
	const found = webpChunks(file).find((entry) => entry.type === type);
	if (!found) throw new Error(`The fixture has no ${type} chunk.`);
	return found;
};

/** An owned copy, so fixtures are plain `Buffer<ArrayBuffer>` values like the other fixtures. */
const owned = (bytes: Buffer) => Buffer.from(bytes);

const width = 3;
const height = 2;
const rgb = () => sharp({ create: { width, height, channels: 3, background: "#103254" } });
const rgba = () =>
	sharp({
		create: { width, height, channels: 4, background: { r: 16, g: 50, b: 84, alpha: 0.5 } },
	});
const xmpPacket = '<x:xmpmeta xmlns:x="adobe:ns:meta/"></x:xmpmeta>';

async function authorWebpFixtures() {
	const lossy = owned(await rgb().webp().toBuffer());
	const lossless = owned(await rgb().webp({ lossless: true }).toBuffer());
	const lossyAlpha = owned(await rgba().webp().toBuffer());
	const losslessAlpha = owned(await rgba().webp({ lossless: true }).toBuffer());
	const metadata = owned(
		await rgb()
			.withIccProfile("srgb")
			.withExif({ IFD0: { Copyright: "Siluet fixture" } })
			.withXmp(xmpPacket)
			.webp()
			.toBuffer(),
	);
	const frames = await Promise.all(
		["#103254", "#e0a040"].map((background) =>
			sharp({ create: { width, height, channels: 3, background } })
				.png()
				.toBuffer(),
		),
	);
	const animated = owned(
		await sharp(frames, { join: { animated: true } })
			.webp({ loop: 0 })
			.toBuffer(),
	);

	const vp8 = only(lossy, "VP8 ");
	const vp8l = only(lossless, "VP8L");
	const vp8lAlpha = only(losslessAlpha, "VP8L");
	const alph = only(lossyAlpha, "ALPH");
	const vp8Alpha = only(lossyAlpha, "VP8 ");
	const iccp = only(metadata, "ICCP");
	const exif = only(metadata, "EXIF");
	const xmp = only(metadata, "XMP ");
	// An odd-length XMP packet exercises the pad byte.
	const oddXmp = chunk("XMP ", `${xmpPacket} `);
	const { icc, alpha, exif: exifFlag, xmp: xmpFlag, animation } = vp8xFlags;
	const both = exifFlag | xmpFlag;

	return {
		saves: {
			lossy,
			lossless,
			lossyAlpha,
			losslessAlpha,
			"ICC, EXIF then XMP": metadata,
			"XMP then EXIF": riffWebp([vp8x(icc | both, width, height), iccp, vp8, xmp, exif]),
			"extended lossless with alpha": riffWebp([
				vp8x(alpha | exifFlag, width, height),
				vp8lAlpha,
				exif,
			]),
			"odd XMP with a zero pad": riffWebp([vp8x(xmpFlag, width, height), vp8, oddXmp]),
			"extended with no flags": riffWebp([vp8x(0, width, height), vp8]),
			"ICCP, ALPH then VP8": riffWebp([vp8x(icc | alpha, width, height), iccp, alph, vp8Alpha]),
		},
		held: {
			animated,
			"animation flag on a still image": riffWebp([vp8x(animation, width, height), vp8]),
			"ANIM chunk": riffWebp([vp8x(0, width, height), chunk("ANIM", Buffer.alloc(6)), vp8]),
			"ANMF without ANIM": riffWebp([vp8x(0, width, height), chunk("ANMF", vp8.data), vp8]),
			// The declared RIFF size fits the file, so the walk refuses before the overrun.
			"overrunning ANMF without the flag": overrun(riffWebp([vp8x(0, width, height)]), "ANMF"),
			"overrunning ANMF with the flag": overrun(riffWebp([vp8x(animation, width, height)]), "ANMF"),
			"no image chunk": riffWebp([vp8x(0, width, height)]),
			"no chunks": riffWebp([]),
			"RIFF size below 4": riffSize(riffWebp([vp8]), 3),
			"VP8X size other than 10": riffWebp([
				{ type: "VP8X", data: Buffer.concat([vp8x(0, width, height).data, Buffer.alloc(2)]) },
				vp8,
			]),
			"non-zero VP8X reserved bytes": riffWebp([reserved(vp8x(0, width, height)), vp8]),
			// A still WebP holds at most six chunks; the walk stops before the overrun that follows.
			"more chunks than a still holds": overrun(
				riffWebp([
					vp8x(0, width, height),
					vp8,
					...Array.from({ length: 5 }, () => chunk("ABCD", Buffer.alloc(2))),
				]),
			),
			"odd XMP with a non-zero pad": riffWebp([vp8x(xmpFlag, width, height), vp8, oddXmp], 1),
			"odd XMP without its pad": shortened(
				riffWebp([vp8x(xmpFlag, width, height), vp8, oddXmp]),
				1,
			),
			"trailing bytes": Buffer.concat([lossless, Buffer.alloc(4)]),
			"unknown chunk": riffWebp([vp8x(0, width, height), vp8, chunk("ABCD", Buffer.alloc(4))]),
			"metadata in the simple format": riffWebp([vp8, exif]),
			"repeated EXIF": riffWebp([vp8x(exifFlag, width, height), vp8, exif, exif]),
			"repeated XMP": riffWebp([vp8x(xmpFlag, width, height), vp8, xmp, xmp]),
			"ALPH with VP8L": riffWebp([vp8x(alpha, width, height), alph, vp8l]),
			"ALPH not directly before VP8": riffWebp([vp8x(icc | alpha, width, height), alph, iccp, vp8]),
			"ICCP after the image": riffWebp([vp8x(icc, width, height), vp8, iccp]),
			"metadata before the image": riffWebp([vp8x(exifFlag, width, height), exif, vp8]),
			"two image chunks": riffWebp([vp8x(0, width, height), vp8, vp8]),
			"EXIF flag without EXIF": riffWebp([vp8x(exifFlag, width, height), vp8]),
			"EXIF without its flag": riffWebp([vp8x(0, width, height), vp8, exif]),
			"ICCP without its flag": riffWebp([vp8x(0, width, height), iccp, vp8]),
			"alpha flag on an opaque image": riffWebp([vp8x(alpha, width, height), vp8]),
			"ALPH without the alpha flag": riffWebp([vp8x(0, width, height), alph, vp8]),
			"VP8L alpha without the alpha flag": riffWebp([vp8x(0, width, height), vp8lAlpha]),
			"reserved VP8X flag": riffWebp([vp8x(0x01, width, height), vp8]),
			"wrong canvas width": riffWebp([vp8x(0, width + 1, height), vp8]),
			"wrong canvas height": riffWebp([vp8x(0, width, height + 1), vp8l]),
		},
		/** Incomplete transfers: Save retries these as a failed download. */
		truncated: {
			"cut short": owned(lossless.subarray(0, -6)),
			"cut short with a rewritten size": shortened(lossy, 6),
			"header only": owned(lossy.subarray(0, 12)),
			// A real cut-off still declares the whole file, so it retries before any walk.
			"animated cut short": owned(animated.subarray(0, -6)),
		},
	};
}

let authored: ReturnType<typeof authorWebpFixtures> | undefined;
/** Every WebP fixture, authored once per process. */
export const webpFixtures = () => {
	authored ??= authorWebpFixtures();
	return authored;
};
