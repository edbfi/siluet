import { refuseJpeg } from "./jpeg-errors";

// Bits and Huffman symbols of entropy-coded data, read exactly as far as a
// decoder reads them. ITU-T T.81 Annexes C and F.2.2.
// https://www.w3.org/Graphics/JPEG/itu-t81.pdf

// `lookup` maps the next 8 bits to (length << 8 | symbol) for codes up to 8 bits.
export type Huffman = {
	maxCode: Int32Array;
	offset: Int32Array;
	symbols: Buffer;
	lookup: Uint16Array;
};
export type EntropyReader = ReturnType<typeof entropyReader>;

/** Read the entropy-coded data in `bytes[start, end)`, where `end` is the marker that follows it. */
export function entropyReader(bytes: Buffer, start: number, end: number) {
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

	return {
		/** The next `size` (at most 15) bits as an unsigned number. */
		read(size: number) {
			while (count < size) if (!fill()) refuseJpeg("invalid");
			count -= size;
			return (buffer >> count) & ((1 << size) - 1);
		},
		decode({ maxCode, offset, symbols, lookup }: Huffman) {
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
		},
		/** End a restart interval: padding, then exactly the expected RSTn marker. */
		restart(marker: number) {
			align();
			if (bytes[position] !== 0xff || bytes[position + 1] !== marker) refuseJpeg("invalid");
			position += 2;
		},
		/** End the scan: padding, then the next marker with no byte in between. */
		finish() {
			align();
			if (position !== end) refuseJpeg("trailer");
		},
	};
}
