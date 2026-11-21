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

// GIF89a Appendix B. Walk the container without expanding compressed frame data.
// https://www.w3.org/Graphics/GIF/spec-gif89a.txt
export function hasCompleteGifStream(bytes: Uint8Array): boolean {
	let offset = 13 + colorTableSize(bytes[10]);
	let hasImage = false;
	while (offset < bytes.length) {
		const block = bytes[offset++];
		if (block === 0x3b) return hasImage && offset === bytes.length;

		if (block === 0x2c) {
			const packed = bytes[offset + 8];
			if (packed === undefined) return false;
			offset += 9 + colorTableSize(packed);
			const codeSize = bytes[offset++];
			if (codeSize === undefined || codeSize < 2 || codeSize > 8 || !bytes[offset]) return false;
			hasImage = true;
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
