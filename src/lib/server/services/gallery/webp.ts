/**
 * The RIFF walk Gallery runs on a WebP before decoding it (D5, docs/SPEC-catalog-engine.md
 * "Images and still WebP"). Container layout and bitstream headers:
 * https://developers.google.com/speed/webp/docs/riff_container (RFC 9649).
 *
 * - `incomplete`: the RIFF size or a chunk runs past the file, or the image chunk's header is
 *   damaged. Save treats it as a failed download.
 * - `refused`: a complete container outside the still profile. Save holds it.
 * - `still`: one still image, with the image chunk's dimensions.
 */
export type WebpContainer =
	| { kind: "incomplete" }
	| { kind: "refused" }
	| { kind: "still"; width: number; height: number };

type Chunk = { type: string; start: number; size: number };

const flag = { icc: 0x20, alpha: 0x10, exif: 0x08, xmp: 0x04 };
const knownFlags = flag.icc | flag.alpha | flag.exif | flag.xmp;
const incomplete = { kind: "incomplete" } as const;
const refused = { kind: "refused" } as const;

/** Every chunk, if each fits the declared RIFF size and the file; `padded` is false for a bad pad. */
function chunksOf(bytes: Buffer) {
	if (bytes.length < 12 || bytes.readUInt32LE(4) + 8 > bytes.length) return null;
	const end = bytes.readUInt32LE(4) + 8;
	const chunks: Chunk[] = [];
	let padded = true;
	let offset = 12;
	while (offset < end) {
		if (offset + 8 > end) return null;
		const size = bytes.readUInt32LE(offset + 4);
		const start = offset + 8;
		if (start + size > end) return null;
		chunks.push({ type: bytes.toString("latin1", offset, offset + 4), start, size });
		offset = start + size;
		if (size & 1) {
			if (offset === end || bytes[offset] !== 0) padded = false;
			offset++;
		}
	}
	return { chunks, padded, trailing: end !== bytes.length };
}

/** The image chunk's dimensions and alpha bit, or null when its header is damaged. */
function imageHeader(bytes: Buffer, { type, start, size }: Chunk) {
	if (type === "VP8 ") {
		// A key frame (bit 0 clear) with its start code, then 14-bit width and height.
		if (size < 10 || bytes[start] & 1 || bytes.readUIntBE(start + 3, 3) !== 0x9d012a) return null;
		const width = bytes.readUInt16LE(start + 6) & 0x3fff;
		const height = bytes.readUInt16LE(start + 8) & 0x3fff;
		return width && height ? { width, height, alpha: false } : null;
	}
	// VP8L: signature 0x2f, then 14-bit width-1 and height-1, the alpha hint and a zero version.
	if (size < 5 || bytes[start] !== 0x2f) return null;
	const bits = bytes.readUInt32LE(start + 1);
	if (bits >>> 29 !== 0) return null;
	return {
		width: (bits & 0x3fff) + 1,
		height: ((bits >>> 14) & 0x3fff) + 1,
		alpha: Boolean((bits >>> 28) & 1),
	};
}

export function walkWebp(bytes: Buffer): WebpContainer {
	const walked = chunksOf(bytes);
	if (!walked) return incomplete;
	const { chunks } = walked;
	const [first] = chunks;
	if (!first) return incomplete;
	const imageAt = chunks.findIndex((chunk) => chunk.type === "VP8 " || chunk.type === "VP8L");
	if (imageAt < 0) {
		// An animation has frames instead of an image chunk.
		return chunks.some((chunk) => ["ANIM", "ANMF"].includes(chunk.type)) ? refused : incomplete;
	}
	const image = imageHeader(bytes, chunks[imageAt]);
	if (!image) return incomplete;
	if (!walked.padded || walked.trailing) return refused;
	const still = { kind: "still", width: image.width, height: image.height } as const;

	// Simple format: the image chunk alone.
	if (first.type !== "VP8X") return chunks.length === 1 ? still : refused;

	// Extended format: VP8X, optional ICCP, optional ALPH before VP8, the image, then at most
	// one EXIF and one XMP in either order.
	if (first.size !== 10) return refused;
	const flags = bytes[first.start];
	if (flags & ~knownFlags || bytes.readUIntLE(first.start + 1, 3) !== 0) return refused;
	const before = chunks.slice(1, imageAt).map((chunk) => chunk.type);
	const after = chunks.slice(imageAt + 1).map((chunk) => chunk.type);
	const lossy = chunks[imageAt].type === "VP8 ";
	const leading = [[], ["ICCP"], ...(lossy ? [["ALPH"], ["ICCP", "ALPH"]] : [])];
	if (!leading.some((order) => order.join() === before.join())) return refused;
	if (
		after.some((type, index) => !["EXIF", "XMP "].includes(type) || after.indexOf(type) !== index)
	)
		return refused;
	const present = {
		icc: before.includes("ICCP"),
		alpha: before.includes("ALPH") || image.alpha,
		exif: after.includes("EXIF"),
		xmp: after.includes("XMP "),
	};
	for (const name of ["icc", "alpha", "exif", "xmp"] as const)
		if (Boolean(flags & flag[name]) !== present[name]) return refused;
	const canvasWidth = bytes.readUIntLE(first.start + 4, 3) + 1;
	const canvasHeight = bytes.readUIntLE(first.start + 7, 3) + 1;
	return canvasWidth === image.width && canvasHeight === image.height ? still : refused;
}
