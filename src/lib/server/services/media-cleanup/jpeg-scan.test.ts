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

// `band` is Ss, Se and Ah << 4 | Al.
type Scan = { ids: number[]; data: number[]; band?: number[] };

function jpeg(
	width: number,
	height: number,
	sampling: number[],
	scans: Scan[],
	restart = 0,
	tables = zeroTables,
	marker = 0xc0,
) {
	const frame = sampling.flatMap((hv, index) => [index + 1, hv, 0]);
	return Buffer.from([
		0xff,
		0xd8,
		...tables,
		...segment(
			marker,
			8,
			height >> 8,
			height & 255,
			width >> 8,
			width & 255,
			sampling.length,
			...frame,
		),
		...(restart ? segment(0xdd, restart >> 8, restart & 255) : []),
		...scans.flatMap(({ ids, data, band = [0, 63, 0] }) => [
			...segment(0xda, ids.length, ...ids.flatMap((id) => [id, 0x00]), ...band),
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

// A 32×8 gray SOF2 image of four blocks, two per restart interval. DC carries
// weight 64, so a refinement bit of 1 lifts its block from 128 to 136. The AC
// table codes 00 = one ±1 coefficient, 01 = EOB1 (a run of 2–3 blocks), 10 = EOB.
const dcTables = [
	...segment(0xdb, 0, ...Array(64).fill(64)),
	...segment(0xc4, 0x00, 1, ...Array(15).fill(0), 0x00),
];
const acTable = (...symbols: number[]) =>
	segment(0xc4, 0x10, 0, symbols.length, ...Array(14).fill(0), ...symbols);
const progressiveTables = [...dcTables, ...acTable(0x01, 0x10, 0x00)];
const intervals = (first: number, second: number) => [first, 0xff, 0xd0, second];
const progression = (): Scan[] => [
	// DC first, Al = 1: category 0 in every block.
	{ ids: [1], band: [0, 0, 0x01], data: intervals(0x3f, 0x3f) },
	// AC 1–5 first, Al = 1: blocks 0 and 2 get coefficient 1, then EOB; 1 and 3 EOB.
	{ ids: [1], band: [1, 5, 0x01], data: intervals(0x35, 0x35) },
	// AC 6–63 first: one EOB1 run of two blocks per interval.
	{ ids: [1], band: [6, 63, 0x00], data: intervals(0x5f, 0x5f) },
	// AC 1–5 refinement: block 0 corrects coefficient 1 and gains coefficient 2;
	// blocks 2 and 3 form an EOB1 run that still corrects block 2's coefficient 1.
	{ ids: [1], band: [1, 5, 0x10], data: intervals(0x2a, 0x5f) },
	// DC refinement: one raw bit per block, 1 0 | 0 1.
	{ ids: [1], band: [0, 0, 0x10], data: intervals(0xbf, 0x7f) },
];
const progressiveJpeg = (scans = progression(), restart = 2, sampling = [0x11]) =>
	jpeg(32, 8, sampling, scans, restart, progressiveTables, 0xc2);
const refuses = (source: Buffer, code: string) =>
	expect(() => readJpeg(source)).toThrow(expect.objectContaining({ code }));
const withScan = (index: number, scan: Partial<Scan>) =>
	progression().map((original, i) => (i === index ? { ...original, ...scan } : original));

describe("walkScan in progressive frames", () => {
	test("decodes every progressive scan through restart intervals as libjpeg does", async () => {
		const source = progressiveJpeg();
		expect(await cleanJpeg(source)).toEqual({ bytes: source, transform: "none" });
		const { data, info } = await sharp(source)
			.extractChannel(0)
			.raw()
			.toBuffer({ resolveWithObject: true });
		expect(info).toMatchObject({ width: 32, height: 8, channels: 1 });
		const blocks = [0, 1, 2, 3].map((block) =>
			Array.from({ length: 64 }, (_, i) => data[(i >> 3) * 32 + block * 8 + (i & 7)]),
		);
		const means = blocks.map((block) => block.reduce((sum, value) => sum + value) / 64);
		for (const [index, mean] of [136, 128, 128, 136].entries()) {
			expect(Math.abs(means[index] - mean)).toBeLessThanOrEqual(1);
		}
		expect(blocks.map((block) => new Set(block).size > 1)).toEqual([true, false, true, false]);
		// A restart ends an EOB run early: an EOB1 run of three in the first
		// interval leaves both blocks of the second to code their own EOB.
		const cut = progressiveJpeg(withScan(2, { data: intervals(0x7f, 0xaf) }));
		expect(await cleanJpeg(cut)).toEqual({ bytes: cut, transform: "none" });
	});

	test("refuses bytes hidden in, between or after progressive scans", () => {
		const scans = progression();
		const hide = (index: number, data: number[]) =>
			progressiveJpeg(scans.map((scan, i) => (i === index ? { ...scan, data } : scan)));
		refuses(hide(0, [0x3f, 0x41, 0xff, 0xd0, 0x3f]), "invalid");
		refuses(hide(1, [0x35, 0xff, 0xd0, 0x35, 0x41]), "trailer");
		refuses(hide(3, [0x2a, 0xff, 0xd0, 0x5f, 0xff, 0x00]), "trailer");
		refuses(hide(4, [0xbf, 0xff, 0xd0, 0x7f, 0x41]), "trailer");
		// A missing restart marker or one interval too few.
		refuses(hide(2, [0x5f, 0x5f]), "invalid");
		refuses(hide(4, [0xbf]), "invalid");
		// A zero pad bit after the DC refinement bits.
		refuses(hide(4, [0xbe, 0xff, 0xd0, 0x7f]), "invalid");
	});

	test("refuses invalid spectral selection and successive approximation", () => {
		const invalid = [
			withScan(1, { band: [0, 5, 0x01] }), // a DC scan with Se > 0
			withScan(1, { band: [5, 1, 0x01] }), // Se < Ss
			withScan(2, { band: [6, 64, 0x00] }), // Se beyond 63
			withScan(0, { band: [0, 0, 0x0e] }), // Al above 13
			withScan(3, { band: [1, 5, 0x21] }), // Ah not the previous Al
			withScan(4, { band: [0, 0, 0x20] }), // Ah ≠ Al + 1
			[progression()[1], ...progression().slice(2)], // AC before DC
			[...progression().slice(0, 3), progression()[1], ...progression().slice(3)], // repeated first scan
			progression().filter((_, i) => i !== 1), // refinement without a first scan
		];
		for (const scans of invalid) refuses(progressiveJpeg(scans), "invalid");
		// AC scans code one component; a three-component frame may interleave only DC.
		const color = (scans: Scan[]) => progressiveJpeg(scans, 0, [0x11, 0x11, 0x11]);
		const dc = { ids: [1, 2, 3], band: [0, 0, 0x00], data: [0x00, 0x0f] };
		expect(readJpeg(color([dc])).frame.progressive).toBe(true);
		refuses(color([dc, { ids: [1, 2], band: [1, 63, 0x00], data: [0x5f] }]), "invalid");
	});

	test("refuses a coefficient outside the band or a refinement of more than one bit", () => {
		// AC 1–1 first: a coefficient after a run of one would land at k = 2.
		// The AC table codes 00 = a run of one then ±1, 01 = EOB1, 10 = a size-2 coefficient.
		const runTables = [...dcTables, ...acTable(0x11, 0x10, 0x02)];
		const dc = { ids: [1], band: [0, 0, 0x00], data: [0x7f] };
		const single = (band: number[], data: number[]) =>
			jpeg(8, 8, [0x11], [dc, { ids: [1], band, data }], 0, runTables, 0xc2);
		expect(readJpeg(single([1, 2, 0x00], [0x3f])).frame.progressive).toBe(true);
		refuses(single([1, 1, 0x00], [0x3f]), "invalid");
		// In a refinement scan a new coefficient is exactly ±1, so size 2 is malformed.
		const refine = jpeg(
			8,
			8,
			[0x11],
			[
				dc,
				{ ids: [1], band: [1, 5, 0x01], data: [0x7f] },
				// Size 2, sign 0, then EOB1: well formed but for the size.
				{ ids: [1], band: [1, 5, 0x10], data: [0x8b] },
			],
			0,
			runTables,
			0xc2,
		);
		refuses(refine, "invalid");
	});
});
