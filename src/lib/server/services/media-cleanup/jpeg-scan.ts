import { refuseJpeg } from "./jpeg-errors";
import type { JpegFrame } from "./jpeg-markers";

// Sequential Huffman scans are walked symbol by symbol so that an upright copy
// keeps no bytes the decoder never reads. ITU-T T.81 Annexes B, C and F.
// https://www.w3.org/Graphics/JPEG/itu-t81.pdf

// `lookup` maps the next 8 bits to (length << 8 | symbol) for codes up to 8 bits.
type Huffman = { maxCode: Int32Array; offset: Int32Array; symbols: Buffer; lookup: Uint16Array };
export type ScanTables = { huffman: (Huffman | undefined)[]; restart: number };

export function scanTables(): ScanTables {
	return { huffman: [], restart: 0 };
}

// B.2.4.2 and C: canonical codes, refusing tables libjpeg refuses.
export function defineHuffman(tables: ScanTables, data: Buffer) {
	for (let i = 0; i < data.length; ) {
		if (i + 17 > data.length || data[i] >> 4 > 1 || (data[i] & 15) > 3) refuseJpeg("invalid");
		const counts = data.subarray(i + 1, i + 17);
		const total = counts.reduce((sum, count) => sum + count, 0);
		if (total > 256 || i + 17 + total > data.length) refuseJpeg("invalid");
		const symbols = data.subarray(i + 17, i + 17 + total);
		const maxCode = new Int32Array(17).fill(-1);
		const offset = new Int32Array(17);
		const lookup = new Uint16Array(256);
		for (let length = 1, code = 0, index = 0; length <= 16; length++, code <<= 1) {
			const count = counts[length - 1];
			if (code + count >= 1 << length) refuseJpeg("invalid");
			offset[length] = index - code;
			for (let n = 0; length <= 8 && n < count; n++) {
				const first = (code + n) << (8 - length);
				lookup.fill((length << 8) | symbols[index + n], first, first + (1 << (8 - length)));
			}
			code += count;
			index += count;
			if (count) maxCode[length] = code - 1;
		}
		tables.huffman[(data[i] >> 4) * 4 + (data[i] & 15)] = { maxCode, offset, symbols, lookup };
		i += 17 + total;
	}
}

export function defineRestart(tables: ScanTables, data: Buffer) {
	if (data.length !== 2) refuseJpeg("invalid");
	tables.restart = data.readUInt16BE(0);
}

function readScan(sos: Buffer, frame: JpegFrame, tables: ScanTables) {
	const count = sos[0];
	if (!count || count > frame.components.length || sos.length !== 4 + 2 * count) {
		refuseJpeg("invalid");
	}
	// Sequential DCT: full spectrum, no successive approximation.
	if (sos[1 + 2 * count] !== 0 || sos[2 + 2 * count] !== 63 || sos[3 + 2 * count] !== 0) {
		refuseJpeg("invalid");
	}
	let previous = -1;
	const components = [];
	for (let i = 1; i < 1 + 2 * count; i += 2) {
		const index = frame.components.findIndex(({ id }) => id === sos[i]);
		if (index <= previous) refuseJpeg("invalid");
		previous = index;
		if (sos[i + 1] >> 4 > 3 || (sos[i + 1] & 15) > 3) refuseJpeg("invalid");
		const dc = tables.huffman[sos[i + 1] >> 4];
		const ac = tables.huffman[4 + (sos[i + 1] & 15)];
		if (!dc || !ac) refuseJpeg("invalid");
		components.push({ ...frame.components[index], dc, ac });
	}
	return components;
}

// A.2: an interleaved MCU covers every scan component's h×v blocks; a single
// component scan codes that component's blocks one at a time.
function layout(frame: JpegFrame, components: ReturnType<typeof readScan>) {
	const h = Math.max(...frame.components.map((component) => component.h));
	const v = Math.max(...frame.components.map((component) => component.v));
	if (components.length === 1) {
		const [component] = components;
		const columns = Math.ceil(Math.ceil((frame.width * component.h) / h) / 8);
		const rows = Math.ceil(Math.ceil((frame.height * component.v) / v) / 8);
		return { mcus: columns * rows, blocks: [component] };
	}
	const blocks = components.flatMap((component) =>
		Array.from({ length: component.h * component.v }, () => component),
	);
	if (blocks.length > 10) refuseJpeg("invalid");
	const mcus = Math.ceil(frame.width / (8 * h)) * Math.ceil(frame.height / (8 * v));
	return { mcus, blocks };
}

/**
 * Decode every Huffman symbol of a sequential scan in `bytes[start, end)`, where
 * `end` is the marker that follows it. Refuse data the decoder would not read.
 */
export function walkScan(
	bytes: Buffer,
	sos: Buffer,
	start: number,
	end: number,
	frame: JpegFrame,
	tables: ScanTables,
) {
	const { mcus, blocks } = layout(frame, readScan(sos, frame, tables));
	let position = start;
	// At most 15 unread bits stay buffered between reads; `last` is where the
	// newest buffered byte starts, so an unused byte can be given back.
	let last = start;
	let buffer = 0;
	let count = 0;

	// F.1.2.3: only a stuffed zero may follow 0xFF inside entropy data.
	const fill = () => {
		if (position >= end || (bytes[position] === 0xff && bytes[position + 1] !== 0)) return false;
		last = position;
		buffer = ((buffer << 8) | bytes[position]) & 0xffffff;
		position += bytes[position] === 0xff ? 2 : 1;
		count += 8;
		return true;
	};
	const skip = (size: number) => {
		while (count < size) if (!fill()) refuseJpeg("invalid");
		count -= size;
	};
	const decode = ({ maxCode, offset, symbols, lookup }: Huffman) => {
		if (count < 8) fill();
		if (count >= 8) {
			const entry = lookup[(buffer >> (count - 8)) & 255];
			if (entry) {
				count -= entry >> 8;
				return entry & 255;
			}
		}
		for (let length = 1, code = 0; length <= 16; length++) {
			if (!count && !fill()) refuseJpeg("invalid");
			code = (code << 1) | ((buffer >> --count) & 1);
			if (code <= maxCode[length]) return symbols[code + offset[length]];
		}
		return refuseJpeg("invalid");
	};
	// F.1.2.3: an interval ends with at most seven 1-bits of padding.
	const align = () => {
		if (count >= 8) {
			position = last;
			count -= 8;
			buffer >>= 8;
		}
		const padding = (1 << count) - 1;
		if ((buffer & padding) !== padding) refuseJpeg("invalid");
		buffer = 0;
		count = 0;
	};

	for (let mcu = 0; mcu < mcus; mcu++) {
		if (tables.restart && mcu && mcu % tables.restart === 0) {
			align();
			const marker = 0xd0 + ((mcu / tables.restart - 1) & 7);
			if (bytes[position] !== 0xff || bytes[position + 1] !== marker) refuseJpeg("invalid");
			position += 2;
		}
		for (const { dc, ac } of blocks) {
			const size = decode(dc);
			if (size > 11) refuseJpeg("invalid");
			skip(size);
			for (let k = 1; k < 64; ) {
				const symbol = decode(ac);
				const run = symbol >> 4;
				const size = symbol & 15;
				if (!size) {
					if (run === 0) break;
					if (run !== 15 || k + 16 > 64) refuseJpeg("invalid");
					k += 16;
					continue;
				}
				if (size > 10 || k + run > 63) refuseJpeg("invalid");
				skip(size);
				k += run + 1;
			}
		}
	}
	align();
	if (position !== end) refuseJpeg("trailer");
}
