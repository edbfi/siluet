import { type EntropyReader, entropyReader, type Huffman } from "./jpeg-entropy";
import { refuseJpeg } from "./jpeg-errors";
import type { JpegFrame } from "./jpeg-markers";
import { type Progression, progressiveCoder } from "./jpeg-progressive";

// Every Huffman scan is walked symbol by symbol so that an upright copy keeps
// no bytes the decoder never reads. ITU-T T.81 Annexes B, C, F and G.
// https://www.w3.org/Graphics/JPEG/itu-t81.pdf

export type ScanState = {
	huffman: (Huffman | undefined)[];
	restart: number;
	progression: Progression;
};

export function scanState(): ScanState {
	return { huffman: [], restart: 0, progression: { coded: [], nonzero: [] } };
}

// B.2.4.2 and C: canonical codes, refusing tables libjpeg refuses.
export function defineHuffman(state: ScanState, data: Buffer) {
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
		state.huffman[(data[i] >> 4) * 4 + (data[i] & 15)] = { maxCode, offset, symbols, lookup };
		i += 17 + total;
	}
}

export function defineRestart(state: ScanState, data: Buffer) {
	if (data.length !== 2) refuseJpeg("invalid");
	state.restart = data.readUInt16BE(0);
}

// T.81 Tables F.1 and F.2: P-bit samples give DC difference categories up to
// P + 3 and AC sizes up to P + 2 (8-bit: 11 and 10; 12-bit: 15 and 14). G.1.2.1
// and G.1.2.2 code a progressive first scan's values after the point transform,
// so category plus Al stays within the same bound. libjpeg's jdhuff.c and
// jdphuff.c store a coefficient, `s << Al` in a progressive scan, in a 16-bit
// JCOEF, where a larger value can truncate to zero and change which refinement
// bits the decoder reads.
// https://github.com/libjpeg-turbo/libjpeg-turbo/blob/3.2.1/src/jdphuff.c
export type CoefficientBits = { dc: number; ac: number };

function coefficientBits({ precision }: JpegFrame, al: number): CoefficientBits {
	return { dc: precision + 3 - al, ac: precision + 2 - al };
}

// Stands in for a table the scan never decodes with; any symbol is refused.
const unused: Huffman = {
	maxCode: new Int32Array(17).fill(-1),
	offset: new Int32Array(17),
	symbols: Buffer.alloc(0),
	lookup: new Uint16Array(256),
};

function readScan(sos: Buffer, frame: JpegFrame, { huffman }: ScanState) {
	const count = sos[0];
	if (!count || count > frame.components.length || sos.length !== 4 + 2 * count) {
		refuseJpeg("invalid");
	}
	const ss = sos[1 + 2 * count];
	const se = sos[2 + 2 * count];
	const ah = sos[3 + 2 * count] >> 4;
	const al = sos[3 + 2 * count] & 15;
	if (!frame.progressive) {
		// Sequential DCT: full spectrum, no successive approximation.
		if (ss !== 0 || se !== 63 || ah || al) refuseJpeg("invalid");
	} else {
		// G.1.1.1.1: a DC scan may interleave components; an AC scan codes one
		// band of one component. Each refinement adds one bit, as libjpeg requires.
		if (ss === 0 ? se !== 0 : se < ss || se > 63 || count !== 1) refuseJpeg("invalid");
		if (al > 13 || (ah && ah !== al + 1)) refuseJpeg("invalid");
	}
	const usesDc = !frame.progressive || (ss === 0 && !ah);
	const usesAc = !frame.progressive || ss > 0;
	let previous = -1;
	const components = [];
	for (let i = 1; i < 1 + 2 * count; i += 2) {
		const index = frame.components.findIndex(({ id }) => id === sos[i]);
		if (index <= previous) refuseJpeg("invalid");
		previous = index;
		if (sos[i + 1] >> 4 > 3 || (sos[i + 1] & 15) > 3) refuseJpeg("invalid");
		const dc = usesDc ? (huffman[sos[i + 1] >> 4] ?? refuseJpeg("invalid")) : unused;
		const ac = usesAc ? (huffman[4 + (sos[i + 1] & 15)] ?? refuseJpeg("invalid")) : unused;
		components.push({ ...frame.components[index], index, dc, ac });
	}
	return { ss, se, ah, al, components, bits: coefficientBits(frame, al) };
}

type ScanComponent = ReturnType<typeof readScan>["components"][number];

// A.2: an interleaved MCU covers every scan component's h×v blocks; a single
// component scan codes that component's blocks one at a time.
function layout(frame: JpegFrame, components: ScanComponent[]) {
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

// F.2.2: a DC difference category and its bits, then AC run/size pairs up to EOB.
function sequentialCoder(reader: EntropyReader, bits: CoefficientBits) {
	const block = ({ dc, ac }: ScanComponent) => {
		const size = reader.decode(dc);
		if (size > bits.dc) refuseJpeg("invalid");
		reader.read(size);
		for (let k = 1; k < 64; ) {
			const symbol = reader.decode(ac);
			const run = symbol >> 4;
			const size = symbol & 15;
			if (!size) {
				if (run === 0) break;
				if (run !== 15 || k + 16 > 64) refuseJpeg("invalid");
				k += 16;
				continue;
			}
			if (size > bits.ac || k + run > 63) refuseJpeg("invalid");
			reader.read(size);
			k += run + 1;
		}
	};
	return { restart() {}, block };
}

/**
 * Decode every Huffman symbol of a scan in `bytes[start, end)`, where `end` is
 * the marker that follows it. Refuse data the decoder would not read.
 */
export function walkScan(
	bytes: Buffer,
	sos: Buffer,
	start: number,
	end: number,
	frame: JpegFrame,
	state: ScanState,
) {
	const scan = readScan(sos, frame, state);
	const { mcus, blocks } = layout(frame, scan.components);
	const reader = entropyReader(bytes, start, end);
	const coder = frame.progressive
		? progressiveCoder(reader, scan, state.progression, mcus)
		: sequentialCoder(reader, scan.bits);
	for (let mcu = 0; mcu < mcus; mcu++) {
		if (state.restart && mcu && mcu % state.restart === 0) {
			reader.restart(0xd0 + ((mcu / state.restart - 1) & 7));
			coder.restart();
		}
		for (const component of blocks) coder.block(component, mcu);
	}
	reader.finish();
}
