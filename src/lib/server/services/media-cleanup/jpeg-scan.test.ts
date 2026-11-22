import { describe, expect, test } from "bun:test";
import sharp from "sharp";
import { cleanJpeg } from "./jpeg";
import { readJpeg } from "./jpeg-markers";

function segment(code: number, ...fields: number[]) {
	return [0xff, code, (fields.length + 2) >> 8, (fields.length + 2) & 255, ...fields];
}

// One-symbol tables: DC category 0 and AC end-of-block are both the code "0",
// so every all-zero block costs two bits.
const quantization = segment(0xdb, 0, ...Array(64).fill(1));
const endOfBlock = segment(0xc4, 0x10, 1, ...Array(15).fill(0), 0x00);
const zeroTables = [
	...quantization,
	...segment(0xc4, 0x00, 1, ...Array(15).fill(0), 0x00),
	...endOfBlock,
];

type Scan = { ids: number[]; data: number[] };

function jpeg(
	width: number,
	height: number,
	sampling: number[],
	scans: Scan[],
	restart = 0,
	tables = zeroTables,
) {
	const frame = sampling.flatMap((hv, index) => [index + 1, hv, 0]);
	return Buffer.from([
		0xff,
		0xd8,
		...tables,
		...segment(
			0xc0,
			8,
			height >> 8,
			height & 255,
			width >> 8,
			width & 255,
			sampling.length,
			...frame,
		),
		...(restart ? segment(0xdd, restart >> 8, restart & 255) : []),
		...scans.flatMap(({ ids, data }) => [
			...segment(0xda, ids.length, ...ids.flatMap((id) => [id, 0x00]), 0, 63, 0),
			...data,
		]),
		0xff,
		0xd9,
	]);
}

// Two zero blocks per byte: 0b0000 then four padding 1-bits, or one block in 0x3f.
const restartJpeg = (data: number[]) => jpeg(80, 8, [0x11], [{ ids: [1], data }], 1);
const restarts = Array.from({ length: 9 }, (_, i) => [0x3f, 0xff, 0xd0 + (i & 7)]).flat();

describe("walkScan", () => {
	test("follows restart intervals through RST7 back to RST0", async () => {
		const source = restartJpeg([...restarts, 0x3f]);
		expect(await cleanJpeg(source)).toEqual({ bytes: source, transform: "none" });
		const { data, info } = await sharp(source).raw().toBuffer({ resolveWithObject: true });
		expect(info).toMatchObject({ width: 80, height: 8 });
		expect(new Set(data)).toEqual(new Set([128]));
	});

	test("refuses bytes hidden in or after a restart interval", () => {
		const hidden = [0x73, 0x65, 0x63];
		const cases = [
			[restartJpeg([0x3f, ...hidden, ...restarts.slice(1), 0x3f]), "invalid"],
			[restartJpeg([...restarts, 0x3f, ...hidden]), "trailer"],
			[restartJpeg([...restarts, 0x3f, 0xff, 0xd1]), "trailer"],
		] as const;
		for (const [source, code] of cases) {
			expect(() => readJpeg(source)).toThrow(expect.objectContaining({ code }));
		}
	});

	test("refuses a missing, misnumbered or early restart marker", () => {
		const skipped = restarts.filter((_, i) => i < 3 || i > 5);
		for (const data of [
			[0x3f, 0x3f, ...restarts.slice(3), 0x3f],
			[0x3f, 0xff, 0xd1, ...restarts.slice(3), 0x3f],
			[...skipped, 0x3f],
			[...restarts.slice(0, -3), 0x3f],
		]) {
			expect(() => readJpeg(restartJpeg(data))).toThrow(
				expect.objectContaining({ code: "invalid" }),
			);
		}
	});

	test("counts a non-interleaved chroma scan in that component's own blocks", async () => {
		// 24×8 at 4:2:0: luma has 3 blocks and each chroma plane is 12×4, so 2 blocks.
		const scans = (chroma: number[]) => [
			{ ids: [1], data: [0x03] },
			{ ids: [2], data: chroma },
			{ ids: [3], data: [0x0f] },
		];
		const source = jpeg(24, 8, [0x22, 0x11, 0x11], scans([0x0f]));
		expect(await cleanJpeg(source)).toEqual({ bytes: source, transform: "none" });
		expect(() => readJpeg(jpeg(24, 8, [0x22, 0x11, 0x11], scans([0x3f])))).toThrow(
			expect.objectContaining({ code: "invalid" }),
		);
		for (const hidden of [[0x00], [0xff, 0x00]]) {
			expect(() => readJpeg(jpeg(24, 8, [0x22, 0x11, 0x11], scans([0x0f, ...hidden])))).toThrow(
				expect.objectContaining({ code: "trailer" }),
			);
		}
	});

	test("counts an interleaved MCU as every component's sampled blocks", () => {
		// 24×8 at 4:2:0 is two MCUs of 4 + 1 + 1 blocks: 24 bits.
		const interleaved = (data: number[]) =>
			jpeg(24, 8, [0x22, 0x11, 0x11], [{ ids: [1, 2, 3], data }]);
		expect(readJpeg(interleaved([0, 0, 0])).frame.width).toBe(24);
		expect(() => readJpeg(interleaved([0, 0, 0x0f]))).toThrow(
			expect.objectContaining({ code: "invalid" }),
		);
		expect(() => readJpeg(interleaved([0, 0, 0, 0xff, 0]))).toThrow(
			expect.objectContaining({ code: "trailer" }),
		);
	});

	test("refuses non-1 padding, undefined codes, missing data and overfull tables", () => {
		const single = (data: number[], tables?: number[]) =>
			jpeg(8, 8, [0x11], [{ ids: [1], data }], 0, tables);
		expect(readJpeg(single([0x3f])).frame.width).toBe(8);
		for (const data of [[0x3e], [0xbf], []]) {
			expect(() => readJpeg(single(data))).toThrow(expect.objectContaining({ code: "invalid" }));
		}
		// Two one-bit codes would leave no prefix for longer codes: libjpeg refuses it.
		const overfull = segment(0xc4, 0x00, 2, ...Array(15).fill(0), 0x00, 0x01);
		expect(() => readJpeg(single([0x3f], [...quantization, ...overfull, ...endOfBlock]))).toThrow(
			expect.objectContaining({ code: "invalid" }),
		);
	});
});
