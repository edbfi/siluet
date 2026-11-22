import type { PngHeader } from "./png-chunks";
import { assertPngActive, PngCleanupError } from "./png-errors";
import { inflatePng } from "./png-inflate";

// Start column, start row, column step, row step.
// https://www.w3.org/TR/png-3/#8InterlaceMethods
const adam7 = [
	[0, 0, 8, 8],
	[4, 0, 8, 8],
	[0, 4, 4, 8],
	[2, 0, 4, 4],
	[0, 2, 2, 4],
	[1, 0, 2, 2],
	[0, 1, 1, 2],
];

function paeth(left: number, above: number, upperLeft: number) {
	const predictor = left + above - upperLeft;
	const leftDistance = Math.abs(predictor - left);
	const aboveDistance = Math.abs(predictor - above);
	const upperLeftDistance = Math.abs(predictor - upperLeft);
	if (leftDistance <= aboveDistance && leftDistance <= upperLeftDistance) return left;
	return aboveDistance <= upperLeftDistance ? above : upperLeft;
}

// Sharp/libpng can accept out-of-range palettes without a warning. For indexed
// images with short palettes, undo byte filters to check precisely the used samples.
// https://www.w3.org/TR/png-3/#9Filters
function checkIndices(
	row: Buffer,
	previous: Buffer | undefined,
	filter: number,
	columns: number,
	depth: number,
	paletteSize: number,
) {
	if (filter !== 0) {
		for (let index = 0; index < row.length; index++) {
			const left = index > 0 ? row[index - 1] : 0;
			const above = previous?.[index] ?? 0;
			const upperLeft = index > 0 ? (previous?.[index - 1] ?? 0) : 0;
			let prediction: number;
			switch (filter) {
				case 1:
					prediction = left;
					break;
				case 2:
					prediction = above;
					break;
				case 3:
					prediction = (left + above) >> 1;
					break;
				default:
					prediction = paeth(left, above, upperLeft);
			}
			row[index] = (row[index] + prediction) & 255;
		}
	}

	const mask = (1 << depth) - 1;
	for (let column = 0; column < columns; column++) {
		const bit = column * depth;
		const sample = (row[bit >> 3] >> (8 - depth - (bit & 7))) & mask;
		if (sample >= paletteSize) throw new PngCleanupError("invalid-png");
	}
}

export async function verifyImageData(
	idat: Buffer[],
	header: PngHeader,
	paletteSize: number,
	signal?: AbortSignal,
) {
	const passes = header.interlace === 1 ? adam7 : [[0, 0, 1, 1]];
	const sizes = passes.flatMap(([x, y, dx, dy]) => {
		if (header.width <= x || header.height <= y) return [];
		const columns = Math.ceil((header.width - x) / dx);
		const rows = Math.ceil((header.height - y) / dy);
		const scanline = Math.ceil((columns * header.channels * header.depth) / 8) + 1;
		return [{ columns, rows, scanline }];
	});
	const expected = sizes.reduce((length, { scanline, rows }) => length + scanline * rows, 0);
	const filtered = await inflatePng(Buffer.concat(idat), expected, {
		invalid: "invalid-png",
		oversized: "invalid-png",
		trailing: "trailing-png-data",
	});
	assertPngActive(signal);
	if (filtered.length !== expected) throw new PngCleanupError("invalid-png");

	const shortPalette = header.color === 3 && paletteSize < 2 ** header.depth;
	let offset = 0;
	for (const { columns, rows, scanline } of sizes) {
		let previous: Buffer | undefined;
		for (let row = 0; row < rows; row++) {
			const filter = filtered[offset];
			if (filter > 4) throw new PngCleanupError("invalid-png");
			if (shortPalette) {
				const current = filtered.subarray(offset + 1, offset + scanline);
				checkIndices(current, previous, filter, columns, header.depth, paletteSize);
				previous = current;
			}
			offset += scanline;
		}
	}
}
