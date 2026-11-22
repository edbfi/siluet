import { refuseJpeg } from "./jpeg-errors";
import { defineHuffman, defineRestart, scanState, walkScan } from "./jpeg-scan";

export const jpegMaxBytes = 16 * 1024 * 1024;
// ToAPIs' file limit bounds a re-encoded copy, which can exceed its source.
export const orientedJpegMaxBytes = 30_000_000;
export const jpegMaxPixels = 16_000_000;
export const jpegMaxScans = 64;
const jpegMaxEdge = 16_384;
const jpegMaxMarkers = 4096;
const frameMarkers = new Set([0xc0, 0xc1, 0xc2]);
const soi = Buffer.from([0xff, 0xd8]);
const eoi = Buffer.from([0xff, 0xd9]);

export type JpegFrame = ReturnType<typeof readFrame>;
type Marker = { code: number; data: Buffer; offset: number; end: number; afterScan: boolean };

function readFrame(code: number, data: Buffer) {
	if (data.length < 6 || data[0] !== 8 || ![1, 3].includes(data[5])) refuseJpeg("unsupported");
	const height = data.readUInt16BE(1);
	const width = data.readUInt16BE(3);
	if (!width || !height || data.length !== 6 + 3 * data[5]) refuseJpeg("invalid");
	if (width > jpegMaxEdge || height > jpegMaxEdge || width * height > jpegMaxPixels)
		refuseJpeg("limit");
	const components = [];
	for (let i = 6; i < data.length; i += 3) {
		const h = data[i + 1] >> 4;
		const v = data[i + 1] & 15;
		if (!h || h > 4 || !v || v > 4 || data[i + 2] > 3) refuseJpeg("unsupported");
		components.push({ id: data[i], h, v, table: data[i + 2] });
	}
	if (new Set(components.map(({ id }) => id)).size !== components.length) refuseJpeg("invalid");
	if (components.length === 1 && (components[0].h !== 1 || components[0].v !== 1)) {
		refuseJpeg("unsupported");
	}
	return { width, height, components, progressive: code === 0xc2 };
}

function scanEnd(bytes: Buffer, start: number) {
	for (let offset = start; offset < bytes.length; ) {
		const marker = bytes.indexOf(0xff, offset);
		if (marker < 0) break;
		offset = marker + 1;
		while (bytes[offset] === 0xff) offset++;
		const code = bytes[offset++];
		if (code !== 0 && !(code >= 0xd0 && code <= 0xd7)) return marker;
	}
	return refuseJpeg("invalid");
}

// Walk every scan, including metadata between progressive scans. Only Huffman
// DCT coding markers and the entropy-coded data each scan decodes enter the
// image data copied to the result.
export function readJpeg(bytes: Buffer, { maxBytes = jpegMaxBytes } = {}) {
	if (bytes.length > maxBytes) refuseJpeg("limit");
	if (!bytes.subarray(0, 2).equals(soi)) refuseJpeg("invalid");
	const image: Buffer[] = [];
	const markers: Marker[] = [];
	let frame: JpegFrame | undefined;
	let scans = 0;
	const scan = scanState();
	for (let offset = 2, count = 0; offset < bytes.length; ) {
		if (++count > jpegMaxMarkers) refuseJpeg("limit");
		const start = offset;
		if (bytes[offset++] !== 0xff) refuseJpeg("invalid");
		while (bytes[offset] === 0xff) offset++;
		const code = bytes[offset++];
		if (code === 0xd9) {
			if (!frame || !scans) refuseJpeg("invalid");
			return { image, markers, frame, trailer: offset !== bytes.length };
		}
		if (code === 0xd8) refuseJpeg("secondary");
		if (offset + 2 > bytes.length) refuseJpeg("invalid");
		const size = bytes.readUInt16BE(offset);
		const end = offset + size;
		if (size < 2 || end > bytes.length) refuseJpeg("invalid");
		const data = bytes.subarray(offset + 2, end);
		if (code === 0xfe || (code >= 0xe0 && code <= 0xef)) {
			markers.push({ code, data, offset: start, end, afterScan: scans > 0 });
			offset = end;
			continue;
		}
		if (frameMarkers.has(code)) {
			if (frame) refuseJpeg("secondary");
			frame = readFrame(code, data);
		} else if (code === 0xc4) {
			defineHuffman(scan, data);
		} else if (code === 0xdd) {
			defineRestart(scan, data);
		} else if (code !== 0xda && code !== 0xdb) {
			refuseJpeg("unsupported");
		}
		offset = end;
		if (code === 0xda) {
			if (!frame) refuseJpeg("invalid");
			if (++scans > jpegMaxScans) refuseJpeg("limit");
			offset = scanEnd(bytes, end);
			// libjpeg stops after the last sequential scan line and skips a few
			// bytes before a progressive EOI without a warning, so bytes the
			// scan never codes would otherwise reach the upright copy unseen.
			walkScan(bytes, data, end, offset, frame, scan);
		}
		image.push(bytes.subarray(start, offset));
	}
	return refuseJpeg("invalid");
}

export function writeJpeg(image: Buffer[], metadata: { code: number; data: Buffer }[]) {
	const segments = metadata.map(({ code, data }) => {
		const header = Buffer.from([0xff, code, 0, 0]);
		header.writeUInt16BE(data.length + 2, 2);
		return [header, data];
	});
	return Buffer.concat([soi, ...segments.flat(), ...image, eoi]);
}
