import { crc32 } from "node:zlib";
import { cicpProblem, profileHdr } from "./icc-profile";
import {
	animationChunks,
	hdrChunks,
	maxChunks,
	maxPngBytes,
	pngSignature,
	readHeader,
	readKeywordEnd,
} from "./png-chunks";
import { PngCleanupError } from "./png-errors";
import { inflatePng } from "./png-inflate";

const maxProfileBytes = 1024 * 1024;
const criticalChunks = new Set(["IHDR", "PLTE", "IDAT", "IEND"]);

/**
 * Check that an original is one complete still SDR PNG before it is decoded: valid
 * chunks and CRCs, one run of image data, at most one profile, nothing after IEND,
 * no animation, no HDR declaration (including one inside an embedded profile) and no
 * unknown critical chunk. Ancillary chunks,
 * including other profiles, pass. Follows the Gallery walk (`completePng`) rather
 * than the cleaner's allowlist.
 */
export async function verifyOriginalPng(bytes: Buffer, signal: AbortSignal) {
	if (bytes.length > maxPngBytes) throw new PngCleanupError("png-limit");
	if (!bytes.subarray(0, 8).equals(pngSignature)) throw new PngCleanupError("invalid-png");
	let header: ReturnType<typeof readHeader> | undefined;
	let pixels = false;
	let idat: "before" | "in" | "after" = "before";
	let profile = false;
	let parsed = 0;
	for (let offset = pngSignature.length; offset + 12 <= bytes.length; ) {
		if (signal.aborted) throw new PngCleanupError("cancelled");
		if (parsed++ >= maxChunks) throw new PngCleanupError("png-limit");
		const length = bytes.readUInt32BE(offset);
		const end = offset + 8 + length;
		if (end + 4 > bytes.length) throw new PngCleanupError("invalid-png");
		const type = bytes.toString("latin1", offset + 4, offset + 8);
		if (
			!/^[A-Za-z]{2}[A-Z][A-Za-z]$/.test(type) ||
			crc32(bytes.subarray(offset + 4, end)) !== bytes.readUInt32BE(end)
		)
			throw new PngCleanupError("invalid-png");
		const data = bytes.subarray(offset + 8, end);
		offset = end + 4;
		if (!header) {
			if (type !== "IHDR") throw new PngCleanupError("invalid-png");
			header = readHeader(data);
			continue;
		}
		if (animationChunks.has(type)) throw new PngCleanupError("animated-png");
		if (hdrChunks.has(type)) throw new PngCleanupError("hdr-png");
		if (type === "cICP" && cicpProblem(data) === "hdr") throw new PngCleanupError("hdr-png");
		if (type === "iCCP") {
			// PNG 3rd edition 5.6: at most one iCCP, and IDAT chunks are consecutive.
			if (profile) throw new PngCleanupError("invalid-png");
			profile = true;
			if (await iccpHdr(data)) throw new PngCleanupError("hdr-png");
		}
		if (type === "IDAT") {
			if (idat === "after") throw new PngCleanupError("invalid-png");
			idat = "in";
			if (length > 0) pixels = true;
		} else if (idat === "in") idat = "after";
		if (type === "IHDR") throw new PngCleanupError("invalid-png");
		if (type === "IEND") {
			if (length !== 0 || !pixels) throw new PngCleanupError("invalid-png");
			if (offset !== bytes.length) throw new PngCleanupError("trailing-png-data");
			return header;
		}
		if (/^[A-Z]/.test(type) && !criticalChunks.has(type))
			throw new PngCleanupError("unsupported-png-chunk");
	}
	throw new PngCleanupError("invalid-png");
}

// The profile inflates within a bound. One the HDR test cannot read is metadata and passes.
async function iccpHdr(data: Buffer) {
	const nameEnd = readKeywordEnd(data, "invalid-png");
	if (data[nameEnd + 1] !== 0) throw new PngCleanupError("invalid-png");
	const compressed = data.subarray(nameEnd + 2);
	if (compressed.length > maxProfileBytes + 32 * 1024) throw new PngCleanupError("png-limit");
	const profile = await inflatePng(compressed, maxProfileBytes, {
		invalid: "invalid-png",
		oversized: "png-limit",
	});
	return profileHdr(profile) === "hdr";
}
