import { crc32 } from "node:zlib";
import sharp from "sharp";
import { hasCompleteGifStream } from "../../../shared/image-studio/gif";

const maxPixels = 16_000_000;
const maxEdge = 16_384;
// Allow a bounded decode beyond the publication profile to classify complete results.
const verificationPixels = 20_000_000;
const verificationEdge = 32_768;
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const invalid = () => new Error("The result is not a complete supported image.");

function completePng(bytes: Buffer) {
	let hasPixels = false;
	for (let offset = 8; offset + 12 <= bytes.length; ) {
		const size = bytes.readUInt32BE(offset);
		const end = offset + 8 + size;
		if (end + 4 > bytes.length) return false;
		if (crc32(bytes.subarray(offset + 4, end)) !== bytes.readUInt32BE(end)) return false;
		const type = bytes.toString("latin1", offset + 4, offset + 8);
		// The decoder verifies a single canvas. Do not publish unchecked animation frames.
		if (type === "acTL" || type === "fcTL" || type === "fdAT") return false;
		if (type === "IDAT" && size > 0) hasPixels = true;
		if (type === "IEND") return hasPixels && size === 0 && end + 4 === bytes.length;
		offset = end + 4;
	}
	return false;
}

// libjpeg finishes at the first EOI. Walk length-delimited headers and escaped
// scan data so a second, unchecked image cannot follow the verified pixels.
function completeJpeg(bytes: Buffer) {
	if (bytes.length < 4 || bytes.readUInt16BE(0) !== 0xffd8) return false;
	let offset = 2;
	let inScan = false;
	let scanHasData = false;
	let sawScan = false;
	while (offset < bytes.length) {
		if (inScan) {
			const markerOffset = bytes.indexOf(0xff, offset);
			if (markerOffset > offset) scanHasData = true;
			offset = markerOffset;
		}
		if (offset < 0 || bytes[offset] !== 0xff) return false;
		while (bytes[offset] === 0xff) offset++;
		const marker = bytes[offset++];
		if (inScan && marker === 0) {
			scanHasData = true;
			continue;
		}
		if (inScan && marker >= 0xd0 && marker <= 0xd7) continue;
		if (inScan && !scanHasData) return false;
		if (marker === 0xd9) return sawScan && offset === bytes.length;
		if (marker === 0x01) continue;
		if (offset + 2 > bytes.length) return false;
		const size = bytes.readUInt16BE(offset);
		if (size < 2) return false;
		offset += size;
		inScan = marker === 0xda;
		if (inScan) sawScan = true;
		scanHasData = false;
	}
	return false;
}

// ISO base media boxes can use a 64-bit size, or span the remainder of the file.
function completeHeifBoxes(bytes: Buffer) {
	let offset = 0;
	while (offset < bytes.length) {
		const remaining = bytes.length - offset;
		if (remaining < 8) return false;
		let size = bytes.readUInt32BE(offset);
		let header = bytes.toString("latin1", offset + 4, offset + 8) === "uuid" ? 24 : 8;
		if (size === 0) return remaining >= header;
		if (size === 1) {
			header += 8;
			if (remaining < header) return false;
			const extended = bytes.readBigUInt64BE(offset + 8);
			if (extended > BigInt(remaining)) return false;
			size = Number(extended);
		}
		if (size < header || size > remaining) return false;
		offset += size;
	}
	return true;
}

export class UnsupportedGalleryImage extends Error {
	readonly reason = "unsupported-image" as const;

	constructor() {
		super("unsupported-image");
	}
}

// Restrict decoder selection to raster containers. A failed download can contain
// arbitrary bytes (including an HTML error page) instead of the result image.
function rasterFormat(bytes: Buffer) {
	if (bytes.subarray(0, 8).equals(pngSignature)) return completePng(bytes) ? "png" : null;
	if (completeJpeg(bytes)) return "jpeg";
	const tag = (offset: number, length: number) => bytes.toString("latin1", offset, offset + length);
	if (tag(0, 4) === "RIFF" && tag(8, 4) === "WEBP" && bytes.readUInt32LE(4) === bytes.length - 8)
		return "webp";
	if (["GIF87a", "GIF89a"].includes(tag(0, 6)) && hasCompleteGifStream(bytes)) return "gif";
	if (tag(4, 4) === "ftyp" && ["avif", "avis", "heic", "mif1"].includes(tag(8, 4)))
		return completeHeifBoxes(bytes) ? "heif" : null;
	if (["49492a00", "4d4d002a"].includes(bytes.toString("hex", 0, 4))) return "tiff";
	return null;
}

export async function verifyImage(bytes: Buffer) {
	const expected = rasterFormat(bytes);
	if (!expected) throw invalid();
	const galleryFormat = expected === "png" || expected === "jpeg";

	// Some libjpeg warnings are emitted even when toBuffer() resolves.
	// https://sharp.pixelplumbing.com/api-constructor/
	const decoder = sharp(bytes, {
		limitInputPixels: verificationPixels,
		failOn: "warning",
		animated: !galleryFormat,
	});
	let warned = false;
	decoder.on("warning", () => {
		warned = true;
	});
	const { format, width, height } = await decoder.metadata();
	if (warned || format !== expected || width > verificationEdge || height > verificationEdge)
		throw invalid();
	if (!galleryFormat || width > maxEdge || height > maxEdge || width * height > maxPixels) {
		// Read every pixel for decoder errors without allocating out-of-profile output.
		await decoder.stats();
		if (warned) throw invalid();
		throw new UnsupportedGalleryImage();
	}
	await decoder.raw().toBuffer();
	if (warned) throw invalid();
	return {
		mime: expected === "png" ? ("image/png" as const) : ("image/jpeg" as const),
		width,
		height,
	};
}
