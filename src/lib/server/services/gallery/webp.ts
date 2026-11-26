/**
 * The RIFF walk Gallery runs on a WebP before decoding it (D5, docs/SPEC-catalog-engine.md
 * "Images and still WebP"). Container layout and bitstream headers:
 * https://developers.google.com/speed/webp/docs/riff_container (RFC 9649).
 *
 * - `incomplete`: the RIFF size runs past the file, a chunk runs past the RIFF size before any
 *   refusal applies, or the image chunk's header is damaged. Save treats it as a failed download.
 * - `refused`: a complete container outside the still profile, including one with no image
 *   chunk. Save holds it.
 * - `still`: one still image, with the image chunk's dimensions.
 */
export type WebpContainer =
	| { kind: "incomplete" }
	| { kind: "refused" }
	| { kind: "still"; width: number; height: number };

type Chunk = { type: string; start: number; size: number };

const flag = { icc: 0x20, alpha: 0x10, exif: 0x08, xmp: 0x04, animation: 0x02 };
const knownFlags = flag.icc | flag.alpha | flag.exif | flag.xmp;
// VP8X, ICCP, ALPH, the image chunk, EXIF and XMP.
const stillChunks = 6;
const incomplete = { kind: "incomplete" } as const;
const refused = { kind: "refused" } as const;

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

/**
 * One pass over the chunks that keeps only their types in order: at most six, since a still
 * WebP holds no more. Once the declared RIFF body is present, animation chunks, the animation
 * flag and a seventh chunk refuse at once, before any later chunk that overruns; a transfer cut
 * short of its declared size is incomplete before the walk starts.
 */
function walkChunks(bytes: Buffer) {
	if (bytes.length < 12) return incomplete;
	const riffSize = bytes.readUInt32LE(4);
	if (riffSize < 4) return refused;
	const end = riffSize + 8;
	if (end > bytes.length) return incomplete;
	const types: string[] = [];
	let image: Chunk | undefined;
	let vp8x: Chunk | undefined;
	let padded = true;
	for (let offset = 12; offset < end; ) {
		if (offset + 8 > end) return incomplete;
		const type = bytes.toString("latin1", offset, offset + 4);
		const size = bytes.readUInt32LE(offset + 4);
		if (type === "ANIM" || type === "ANMF" || types.length === stillChunks) return refused;
		const start = offset + 8;
		if (start + size > end) return incomplete;
		types.push(type);
		if (type === "VP8X" && !vp8x) {
			vp8x = { type, start, size };
			if (size > 0 && bytes[start] & flag.animation) return refused;
		}
		if ((type === "VP8 " || type === "VP8L") && !image) image = { type, start, size };
		offset = start + size;
		if (size & 1) {
			if (offset === end || bytes[offset] !== 0) padded = false;
			offset++;
		}
	}
	return { types, image, vp8x, padded, trailing: end !== bytes.length };
}

export function walkWebp(bytes: Buffer): WebpContainer {
	const walked = walkChunks(bytes);
	if ("kind" in walked) return walked;
	const { types, image: imageChunk, vp8x } = walked;
	const header = imageChunk && imageHeader(bytes, imageChunk);
	if (imageChunk && !header) return incomplete;
	if (!header || !walked.padded || walked.trailing) return refused;
	const still = { kind: "still", width: header.width, height: header.height } as const;

	// Simple format: the image chunk alone.
	if (types[0] !== "VP8X") return types.length === 1 ? still : refused;

	// Extended format: VP8X, optional ICCP, optional ALPH before VP8, the image, then at most
	// one EXIF and one XMP in either order.
	if (vp8x?.size !== 10) return refused;
	const flags = bytes[vp8x.start];
	if (flags & ~knownFlags || bytes.readUIntLE(vp8x.start + 1, 3) !== 0) return refused;
	const imageAt = types.indexOf(imageChunk.type);
	const before = types.slice(1, imageAt);
	const after = types.slice(imageAt + 1);
	const lossy = imageChunk.type === "VP8 ";
	const leading = [[], ["ICCP"], ...(lossy ? [["ALPH"], ["ICCP", "ALPH"]] : [])];
	if (!leading.some((order) => order.join() === before.join())) return refused;
	if (
		after.some((type, index) => !["EXIF", "XMP "].includes(type) || after.indexOf(type) !== index)
	)
		return refused;
	const present = {
		icc: before.includes("ICCP"),
		alpha: before.includes("ALPH") || header.alpha,
		exif: after.includes("EXIF"),
		xmp: after.includes("XMP "),
	};
	for (const name of ["icc", "alpha", "exif", "xmp"] as const)
		if (Boolean(flags & flag[name]) !== present[name]) return refused;
	const canvasWidth = bytes.readUIntLE(vp8x.start + 4, 3) + 1;
	const canvasHeight = bytes.readUIntLE(vp8x.start + 7, 3) + 1;
	return canvasWidth === header.width && canvasHeight === header.height ? still : refused;
}
