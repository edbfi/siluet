import { crc32 } from "node:zlib";
import { PngCleanupError } from "./png-errors";

export const pngSignature = Buffer.from("89504e470d0a1a0a", "hex");
export const maxPngPixels = 8_000_000;
export const maxPngBytes = 16 * 1024 * 1024;
const maxEdge = 16_384;
const maxChunks = 8_192;

const colorTypes = {
	0: { depths: [1, 2, 4, 8, 16], channels: 1 },
	2: { depths: [8, 16], channels: 3 },
	3: { depths: [1, 2, 4, 8], channels: 1 },
	4: { depths: [8, 16], channels: 2 },
	6: { depths: [8, 16], channels: 4 },
} as const;

function readHeader(data: Buffer) {
	if (data.length !== 13) throw new PngCleanupError("invalid-png");
	const width = data.readUInt32BE(0);
	const height = data.readUInt32BE(4);
	const depth = data[8];
	const color = data[9];
	const interlace = data[12];
	if (
		width === 0 ||
		height === 0 ||
		!(color === 0 || color === 2 || color === 3 || color === 4 || color === 6) ||
		data[10] !== 0 ||
		data[11] !== 0 ||
		(interlace !== 0 && interlace !== 1)
	)
		throw new PngCleanupError("invalid-png");
	const { depths, channels } = colorTypes[color];
	if (!depths.some((valid) => valid === depth)) throw new PngCleanupError("invalid-png");
	if (width > maxEdge || height > maxEdge || width * height > maxPngPixels)
		throw new PngCleanupError("png-limit");
	return { width, height, depth, color, interlace, channels };
}

export type PngHeader = ReturnType<typeof readHeader>;

const colorChunks = new Set(["cHRM", "cICP", "gAMA", "iCCP", "sBIT", "sRGB"]);
const afterPaletteChunks = new Set(["bKGD", "hIST", "tRNS"]);
const beforeImageChunks = new Set(["eXIf", "pHYs", "sPLT"]);
const textChunks = new Set(["iTXt", "tEXt", "zTXt"]);
const animationChunks = new Set(["acTL", "fcTL", "fdAT"]);
// https://www.w3.org/TR/png-3/#11cLLI and https://github.com/w3c/png/issues/380
const hdrChunks = new Set(["mDCV", "cLLI", "gMAP", "gDAT", "gmAP", "gdAT"]);

const knownChunks = new Set([
	"IHDR",
	"PLTE",
	"IDAT",
	"IEND",
	"caBX",
	"tIME",
	...colorChunks,
	...afterPaletteChunks,
	...beforeImageChunks,
	...textChunks,
]);

export function readKeywordEnd(data: Buffer, code: PngCleanupError["code"]) {
	const end = data.subarray(0, 80).indexOf(0);
	if (end < 1 || data[0] === 32 || data[end - 1] === 32) throw new PngCleanupError(code);
	for (let index = 0; index < end; index++) {
		const byte = data[index];
		if (byte < 32 || (byte > 126 && byte < 161) || (byte === 32 && data[index - 1] === 32)) {
			throw new PngCleanupError(code);
		}
	}
	return end;
}

export function writePngChunk(type: string, data: Buffer) {
	const chunk = Buffer.alloc(data.length + 12);
	chunk.writeUInt32BE(data.length);
	chunk.write(type, 4, 4, "ascii");
	chunk.set(data, 8);
	chunk.writeUInt32BE(crc32(chunk.subarray(4, -4)), data.length + 8);
	return chunk;
}

function checkPaletteDependentChunk(
	type: string,
	data: Buffer,
	header: PngHeader,
	paletteSize: number,
) {
	const { color, depth } = header;
	if (type === "hIST") {
		if (paletteSize === 0 || data.length !== paletteSize * 2)
			throw new PngCleanupError("invalid-png");
		return;
	}
	if (color === 3) {
		const valid =
			type === "bKGD"
				? data.length === 1 && data[0] < paletteSize
				: data.length > 0 && data.length <= paletteSize;
		if (!valid) throw new PngCleanupError("invalid-png");
		return;
	}
	if (type === "tRNS" && (color === 4 || color === 6)) throw new PngCleanupError("invalid-png");
	if (data.length !== (color === 0 || color === 4 ? 2 : 6))
		throw new PngCleanupError("invalid-png");
	for (let offset = 0; offset < data.length; offset += 2) {
		if (data.readUInt16BE(offset) >= 2 ** depth) throw new PngCleanupError("invalid-png");
	}
}

function checkDiscardedChunk(type: string, data: Buffer) {
	if (type === "tIME") {
		if (
			data.length !== 7 ||
			data[2] < 1 ||
			data[2] > 12 ||
			data[3] < 1 ||
			data[3] > 31 ||
			data[4] > 23 ||
			data[5] > 59 ||
			data[6] > 60
		)
			throw new PngCleanupError("invalid-png");
	}
	if (type === "sPLT") {
		const nameEnd = readKeywordEnd(data, "invalid-png");
		const depth = data[nameEnd + 1];
		const remaining = data.length - nameEnd - 2;
		if ((depth !== 8 && depth !== 16) || remaining <= 0 || remaining % (depth === 8 ? 6 : 10) !== 0)
			throw new PngCleanupError("invalid-png");
		return data.toString("latin1", 0, nameEnd);
	}
}

export function parsePng(bytes: Buffer) {
	if (!bytes.subarray(0, 8).equals(pngSignature)) throw new PngCleanupError("invalid-png");
	const chunks: { type: string; data: Buffer; encoded: Buffer }[] = [];
	const seen = new Set<string>();
	const suggestedPalettes = new Set<string>();
	let header: PngHeader | undefined;
	let paletteSize = 0;
	let inIdat = false;
	let idatSize = 0;
	let parsed = 0;

	// Keep the physical order of retained chunks and check the source including discarded chunks.
	// https://www.w3.org/TR/png-3/#5ChunkOrdering
	for (let offset = pngSignature.length; offset + 12 <= bytes.length; ) {
		// Dropped chunks count too, so skipping cannot make the walk unbounded.
		if (parsed++ >= maxChunks) throw new PngCleanupError("png-limit");
		const length = bytes.readUInt32BE(offset);
		const end = offset + 8 + length;
		if (end + 4 > bytes.length) throw new PngCleanupError("invalid-png");
		const type = bytes.toString("latin1", offset + 4, offset + 8);
		if (
			!/^[A-Za-z]{2}[A-Z][A-Za-z]$/.test(type) ||
			crc32(bytes.subarray(offset + 4, end)) !== bytes.readUInt32BE(end)
		) {
			throw new PngCleanupError("invalid-png");
		}
		const data = bytes.subarray(offset + 8, end);
		const encoded = bytes.subarray(offset, end + 4);
		offset = end + 4;

		if (!header && type !== "IHDR") throw new PngCleanupError("invalid-png");
		if (animationChunks.has(type)) throw new PngCleanupError("animated-png");
		if (hdrChunks.has(type)) throw new PngCleanupError("hdr-png");
		// A decoder may ignore an unknown ancillary chunk, so cleaning drops it, repeated or not.
		// https://www.w3.org/TR/png-3/#5Chunk-naming-conventions
		if (!knownChunks.has(type) && /^[a-z]/.test(type)) {
			inIdat = false;
			continue;
		}
		chunks.push({ type, data, encoded });
		const repeatable =
			type === "IDAT" || type === "sPLT" || type === "caBX" || textChunks.has(type);
		const alreadySeen = seen.has(type);
		if (!repeatable && alreadySeen)
			throw new PngCleanupError(type === "eXIf" ? "png-orientation" : "invalid-png");
		if (
			(colorChunks.has(type) && (seen.has("PLTE") || seen.has("IDAT"))) ||
			((afterPaletteChunks.has(type) || beforeImageChunks.has(type)) && seen.has("IDAT"))
		)
			throw new PngCleanupError("invalid-png");
		seen.add(type);
		if (type !== "IDAT") inIdat = false;

		if (type === "IHDR") {
			header = readHeader(data);
			continue;
		}
		if (!header) throw new PngCleanupError("invalid-png");
		if (type === "IEND") {
			if (length !== 0 || idatSize === 0) throw new PngCleanupError("invalid-png");
			if (offset !== bytes.length) throw new PngCleanupError("trailing-png-data");
			return { chunks, header, paletteSize };
		}
		if (type === "PLTE") {
			paletteSize = length / 3;
			if (
				seen.has("IDAT") ||
				seen.has("tRNS") ||
				seen.has("bKGD") ||
				paletteSize === 0 ||
				paletteSize > 256 ||
				length % 3 !== 0 ||
				header.color === 0 ||
				header.color === 4 ||
				(header.color === 3 && paletteSize > 2 ** header.depth)
			)
				throw new PngCleanupError("invalid-png");
		} else if (type === "IDAT") {
			if ((alreadySeen && !inIdat) || (header.color === 3 && paletteSize === 0))
				throw new PngCleanupError("invalid-png");
			inIdat = true;
			idatSize += length;
		} else if (afterPaletteChunks.has(type)) {
			checkPaletteDependentChunk(type, data, header, paletteSize);
		} else if (type === "sPLT" || type === "tIME") {
			const name = checkDiscardedChunk(type, data);
			if (name !== undefined) {
				if (suggestedPalettes.has(name)) throw new PngCleanupError("invalid-png");
				suggestedPalettes.add(name);
			}
		} else if (
			!colorChunks.has(type) &&
			!beforeImageChunks.has(type) &&
			!textChunks.has(type) &&
			type !== "caBX"
		) {
			throw new PngCleanupError("unsupported-png-chunk");
		}
	}
	throw new PngCleanupError("invalid-png");
}
