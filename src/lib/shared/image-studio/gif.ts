const fixedExtensionSize: Partial<Record<number, number>> = {
	1: 12, // Plain Text Extension
	249: 4, // Graphic Control Extension
	255: 11, // Application Extension
};

function colorTableSize(packed: number): number {
	return packed & 0x80 ? 3 * (2 << (packed & 7)) : 0;
}

function afterSubBlocks(bytes: Uint8Array, offset: number): number | null {
	while (offset < bytes.length) {
		const size = bytes[offset++];
		if (size === 0) return offset;
		offset += size;
	}
	return null;
}

// GIF89a Appendix F. Track dictionary entry lengths without expanding the pixels.
function afterRaster(bytes: Uint8Array, offset: number, pixels: number, lengths: Uint16Array) {
	const minimum = bytes[offset++];
	if (minimum < 2 || minimum > 8 || !pixels) return null;
	const clear = 1 << minimum;
	let next = clear + 2;
	let width = minimum + 1;
	let previous = 0;
	let bits = 0;
	let packed = 0;
	let remaining = pixels;
	while (offset < bytes.length) {
		const end = offset + 1 + bytes[offset];
		offset++;
		if (end === offset || end > bytes.length) return null;
		while (offset < end) {
			packed |= bytes[offset++] << bits;
			bits += 8;
			while (bits >= width) {
				const code = packed & ((1 << width) - 1);
				packed >>>= width;
				bits -= width;
				if (code === clear + 1)
					return remaining === 0 && offset === end && bytes[offset] === 0 ? offset + 1 : null;
				if (code === clear) {
					next = clear + 2;
					width = minimum + 1;
					previous = 0;
					continue;
				}
				if (code > next || (!previous && code >= clear)) return null;
				const length = code < clear ? 1 : code === next ? previous + 1 : lengths[code];
				remaining -= length;
				if (remaining < 0) return null;
				if (previous && next < 4096) {
					lengths[next++] = previous + 1;
					if (next === 1 << width && width < 12) width++;
				}
				previous = length;
			}
		}
	}
	return null;
}

// GIF89a Appendix B. Walk the container without expanding compressed frame data.
// https://www.w3.org/Graphics/GIF/spec-gif89a.txt
export function hasCompleteGifStream(bytes: Uint8Array): boolean {
	let offset = 13 + colorTableSize(bytes[10]);
	let hasImage = false;
	const lengths = new Uint16Array(4096);
	while (offset < bytes.length) {
		const block = bytes[offset++];
		if (block === 0x3b) return hasImage && offset === bytes.length;

		if (block === 0x2c) {
			const packed = bytes[offset + 8];
			if (packed === undefined) return false;
			const width = bytes[offset + 4] | (bytes[offset + 5] << 8);
			const height = bytes[offset + 6] | (bytes[offset + 7] << 8);
			const next = afterRaster(bytes, offset + 9 + colorTableSize(packed), width * height, lengths);
			if (next === null) return false;
			offset = next;
			hasImage = true;
			continue;
		} else if (block === 0x21) {
			const label = bytes[offset++];
			if (label === undefined) return false;
			const size = fixedExtensionSize[label];
			if (size !== undefined && bytes[offset] !== size) return false;
			if (label === 0xf9 && bytes[offset + 5] !== 0) return false;
		} else {
			return false;
		}

		const nextBlock = afterSubBlocks(bytes, offset);
		if (nextBlock === null) return false;
		offset = nextBlock;
	}
	return false;
}
