import { profileHdr } from "./icc-profile";
import { refuseJpeg } from "./jpeg-errors";
import {
	jpegMaxBytes,
	jpegMaxEdge,
	jpegMaxMarkers,
	jpegMaxPixels,
	jpegMaxScans,
} from "./jpeg-markers";
import { gainMapPrefix, iccPrefix, mpfPrefix } from "./jpeg-metadata";

const iccLimit = 1024 * 1024;
const frameMarkers = new Set([0xc0, 0xc1, 0xc2]);
// Every other SOFn names a coding Siluet does not send.
const otherFrames = new Set([0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
const starts = (data: Buffer, prefix: Buffer) => data.subarray(0, prefix.length).equals(prefix);

// Reassemble APP2 ICC_PROFILE chunks by sequence number. A set that does not fit
// together passes here; the decode then checks the profile the decoder assembles.
function iccHdr(parts: Buffer[]) {
	const total = parts.length;
	const sorted = parts.toSorted((a, b) => a[12] - b[12]);
	let size = 0;
	for (const [index, part] of sorted.entries()) {
		if (part.length <= 14 || part[12] !== index + 1 || part[13] !== total) return false;
		size += part.length - 14;
	}
	return (
		profileHdr(
			Buffer.concat(
				sorted.map((part) => part.subarray(14)),
				size,
			),
		) === "hdr"
	);
}

/**
 * Check that an original is one complete still SDR JPEG before it is decoded: one
 * 8-bit Huffman frame with one or three components, nothing after EOI, no secondary
 * image or gain map, and bounded segments, scans and ICC. Other metadata passes.
 * Follows the Gallery walk (`completeJpeg`) rather than the cleaner's table checks.
 */
export function verifyOriginalJpeg(bytes: Buffer) {
	if (bytes.length > jpegMaxBytes) refuseJpeg("limit");
	if (bytes.length < 4 || bytes.readUInt16BE(0) !== 0xffd8) refuseJpeg("invalid");
	let frame: { width: number; height: number } | undefined;
	const icc: Buffer[] = [];
	let iccSize = 0;
	let segments = 0;
	let scans = 0;
	let offset = 2;
	let inScan = false;
	let scanHasData = false;
	while (offset < bytes.length) {
		if (inScan) {
			const marker = bytes.indexOf(0xff, offset);
			if (marker > offset) scanHasData = true;
			if (marker < 0) refuseJpeg("invalid");
			offset = marker;
		}
		if (bytes[offset] !== 0xff) refuseJpeg("invalid");
		while (bytes[offset] === 0xff) offset++;
		const code = bytes[offset++];
		if (inScan && code === 0) {
			scanHasData = true;
			continue;
		}
		// Restart markers carry no length and are not segments.
		if (inScan && code >= 0xd0 && code <= 0xd7) continue;
		if (inScan && !scanHasData) refuseJpeg("invalid");
		inScan = false;
		if (code === 0xd9) {
			if (!frame || !scans) refuseJpeg("invalid");
			if (offset !== bytes.length) refuseJpeg("trailer");
			if (icc.length && iccHdr(icc)) refuseJpeg("hdr");
			return frame;
		}
		if (code === 0xd8) refuseJpeg("secondary");
		if (code === 0x01) continue;
		if (code === undefined || (code >= 0xd0 && code <= 0xd7)) refuseJpeg("invalid");
		if (++segments > jpegMaxMarkers) refuseJpeg("limit");
		if (offset + 2 > bytes.length) refuseJpeg("invalid");
		const size = bytes.readUInt16BE(offset);
		const end = offset + size;
		if (size < 2 || end > bytes.length) refuseJpeg("invalid");
		const data = bytes.subarray(offset + 2, end);
		if (frameMarkers.has(code)) {
			if (frame) refuseJpeg("secondary");
			if (data.length < 6 || data[0] !== 8 || ![1, 3].includes(data[5])) refuseJpeg("unsupported");
			const height = data.readUInt16BE(1);
			const width = data.readUInt16BE(3);
			if (!width || !height || data.length !== 6 + 3 * data[5]) refuseJpeg("invalid");
			if (width > jpegMaxEdge || height > jpegMaxEdge || width * height > jpegMaxPixels)
				refuseJpeg("limit");
			frame = { width, height };
		} else if (otherFrames.has(code)) {
			refuseJpeg("unsupported");
		} else if (code === 0xe2) {
			if (starts(data, mpfPrefix)) refuseJpeg("secondary");
			if (starts(data, gainMapPrefix)) refuseJpeg("hdr");
			if (starts(data, iccPrefix)) {
				iccSize += Math.max(0, data.length - 14);
				if (iccSize > iccLimit) refuseJpeg("limit");
				icc.push(data);
			}
		} else if (code === 0xda) {
			if (!frame) refuseJpeg("invalid");
			if (++scans > jpegMaxScans) refuseJpeg("limit");
			inScan = true;
			scanHasData = false;
		}
		offset = end;
	}
	return refuseJpeg("invalid");
}
