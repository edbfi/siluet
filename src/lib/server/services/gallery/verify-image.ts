import { crc32 } from "node:zlib";
import sharp from "sharp";

const maxPixels = 16_000_000;
const maxEdge = 16_384;
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const invalid = () => new Error("The result is not a complete supported image.");

function completePng(bytes: Buffer) {
	for (let offset = 8; offset + 12 <= bytes.length; ) {
		const size = bytes.readUInt32BE(offset);
		const end = offset + 8 + size;
		if (end + 4 > bytes.length) return false;
		if (crc32(bytes.subarray(offset + 4, end)) !== bytes.readUInt32BE(end)) return false;
		const type = bytes.toString("latin1", offset + 4, offset + 8);
		// The decoder verifies a single canvas. Do not publish unchecked animation frames.
		if (type === "acTL" || type === "fcTL" || type === "fdAT") return false;
		if (type === "IEND") return size === 0 && end + 4 === bytes.length;
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
	while (offset < bytes.length) {
		if (inScan) offset = bytes.indexOf(0xff, offset);
		if (offset < 0 || bytes[offset] !== 0xff) return false;
		while (bytes[offset] === 0xff) offset++;
		const marker = bytes[offset++];
		if (inScan && (marker === 0 || (marker >= 0xd0 && marker <= 0xd7))) continue;
		if (marker === 0xd9) return offset === bytes.length;
		if (marker === 0x01) continue;
		if (offset + 2 > bytes.length) return false;
		const size = bytes.readUInt16BE(offset);
		if (size < 2) return false;
		offset += size;
		inScan = marker === 0xda;
	}
	return false;
}

export async function verifyImage(bytes: Buffer) {
	const png = bytes.subarray(0, 8).equals(pngSignature);
	if (!(png ? completePng(bytes) : completeJpeg(bytes))) throw invalid();

	// Some libjpeg warnings are emitted even when toBuffer() resolves.
	// https://sharp.pixelplumbing.com/api-constructor/
	const decoder = sharp(bytes, { limitInputPixels: maxPixels, failOn: "warning" });
	let warned = false;
	decoder.on("warning", () => {
		warned = true;
	});
	const { format, width, height } = await decoder.metadata();
	if (
		format !== (png ? "png" : "jpeg") ||
		width > maxEdge ||
		height > maxEdge ||
		width * height > maxPixels
	)
		throw invalid();
	await decoder.raw().toBuffer();
	if (warned) throw invalid();
	return { mime: png ? ("image/png" as const) : ("image/jpeg" as const), width, height };
}
