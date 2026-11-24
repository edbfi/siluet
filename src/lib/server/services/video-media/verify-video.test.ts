import { afterAll, expect, spyOn, test } from "bun:test";
import { mkdtemp, open, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	afterFileType,
	appendChild,
	box,
	type ContentCredentialsShape,
	c2paBox,
	h264Aac,
	locate,
	payload,
	topLevelBox,
	undecodableH264Aac,
} from "../../../../../tests/fixtures/video/mp4-boxes";
import { h3MaxShape, seedanceShape } from "../../../../../tests/fixtures/video/real-clips";
import { TruncatedVideoError, UnsupportedVideoError } from "./errors";
import { contentCredentialsByteLimit, movieByteLimit } from "./limits";
import { verifyVideoFile } from "./verify-video";

const directory = await mkdtemp(join(tmpdir(), "siluet-verify-video-"));
afterAll(() => rm(directory, { recursive: true, force: true }));
async function file(bytes: Buffer) {
	const path = join(directory, crypto.randomUUID());
	await writeFile(path, bytes);
	return path;
}
async function refusal(bytes: Buffer | string) {
	try {
		await verifyVideoFile(typeof bytes === "string" ? bytes : await file(bytes));
	} catch (error) {
		return error as Error;
	}
	throw new Error("Expected a refusal.");
}

test("the fixture verifies from its file", async () => {
	expect(await verifyVideoFile(await file(h264Aac()))).toMatchObject({
		width: 96,
		height: 64,
		duration: 2,
	});
});

test("a corrupt PPS behind a valid SPS passes the configuration checks", async () => {
	const bytes = undecodableH264Aac();
	const avcC = payload(bytes, "moov/trak/mdia/minf/stbl/stsd/avc1/avcC");
	expect(avcC.includes(Buffer.from([0x68, 0x82, 0x08]))).toBe(true);
	expect(await verifyVideoFile(await file(bytes))).toMatchObject({ width: 96, height: 64 });
});

test("an EBML file gets the WebM reason", async () => {
	const webm = Buffer.from("1a45dfa39f4286810142f7810142f2810442f381084282847765626d", "hex");
	const error = await refusal(Buffer.concat([webm, Buffer.alloc(64)]));
	expect(error).toBeInstanceOf(UnsupportedVideoError);
	expect((error as UnsupportedVideoError).reason).toBe("webm");
});

test("a file that ends inside a box is truncated, not unsupported", async () => {
	const source = h264Aac();
	const moov = locate(source, "moov")[0];
	for (const end of [source.length - 100, moov.start + 100, source.length + 2]) {
		const bytes =
			end > source.length ? Buffer.concat([source, Buffer.alloc(2)]) : source.subarray(0, end);
		expect(await refusal(bytes)).toBeInstanceOf(TruncatedVideoError);
	}
});

test("trailing boxes, fragments, oversized movies and oversized files are refused", async () => {
	const source = h264Aac();
	for (const [bytes, reason] of [
		[Buffer.concat([source, box("junk")]), /junk at the top level/],
		[Buffer.concat([source, box("moof")]), /fragmented MP4/],
		[
			appendChild(source, "moov", box("free", Buffer.alloc(movieByteLimit))),
			/movie box over 4 MiB/,
		],
	] as const) {
		const error = await refusal(bytes);
		expect(error).toBeInstanceOf(UnsupportedVideoError);
		expect(error.message).toMatch(reason);
	}
	const large = await file(source);
	await truncate(large, 64 * 1024 * 1024 + 1);
	expect((await refusal(large)).message).toMatch(/file size/);
});

/** Grow `source`'s mdat by 60 MiB of holes and record every read verification makes. */
async function readsOfGrown(source: Buffer) {
	const mdat = locate(source, "mdat")[0];
	const extra = 60 * 1024 * 1024;
	const grown = Buffer.from(source);
	grown.writeUInt32BE(mdat.size + extra, mdat.start);
	const path = await file(grown);
	await truncate(path, grown.length + extra);
	const probe = await open(path);
	const proto = Object.getPrototypeOf(probe);
	await probe.close();
	const reads: number[] = [];
	const original = proto.read;
	const spy = spyOn(proto, "read").mockImplementation(function (this: unknown, ...args: unknown[]) {
		if (typeof args[2] === "number") reads.push(args[2]);
		return original.apply(this, args);
	});
	try {
		expect(await verifyVideoFile(path)).toMatchObject({ duration: 2 });
	} finally {
		spy.mockRestore();
	}
	return reads;
}

test("a 60 MiB mdat is checked from headers with at most 4 MiB buffered", async () => {
	const reads = await readsOfGrown(h264Aac());
	expect(Math.max(...reads)).toBeLessThanOrEqual(movieByteLimit);
	expect(reads.reduce((a, b) => a + b, 0)).toBeLessThan(64 * 1024);
});

test("a complete non-MP4 file is unsupported, not truncated", async () => {
	const png = Buffer.concat([
		Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"),
		Buffer.alloc(64),
	]);
	const html = Buffer.from("<!DOCTYPE html><html><body>Not found</body></html>\n");
	for (const bytes of [png, html])
		expect(await refusal(bytes)).toBeInstanceOf(UnsupportedVideoError);
});

test("a file cut at a box boundary before moov or mdat is truncated", async () => {
	const source = h264Aac();
	const [ftyp] = locate(source, "ftyp");
	const [moov] = locate(source, "moov");
	const [mdat] = locate(source, "mdat");
	const span = (node: { start: number; size: number }) =>
		source.subarray(node.start, node.start + node.size);
	const faststartCut = source.subarray(0, moov.start + moov.size);
	const moovLastCut = Buffer.concat([span(ftyp), span(mdat)]);
	for (const bytes of [faststartCut, moovLastCut])
		expect(await refusal(bytes)).toBeInstanceOf(TruncatedVideoError);
	const noFileType = source.subarray(ftyp.size);
	expect(await refusal(noFileType)).toBeInstanceOf(UnsupportedVideoError);
});

test("an H3 Max-shaped clip with a C2PA box verifies", async () => {
	expect(await verifyVideoFile(await file(h3MaxShape()))).toMatchObject({
		width: 96,
		height: 64,
		duration: 2,
	});
});

test("a Seedance-shaped clip verifies", async () => {
	const bytes = seedanceShape();
	expect(
		["ftyp", "uuid", "free", "mdat", "moov"].map((type) => locate(bytes, type)[0].start),
	).toEqual([
		0,
		32,
		32 + 21_456,
		32 + 21_456 + 8,
		bytes.length - topLevelBox(bytes, "moov").length,
	]);
	expect(await verifyVideoFile(await file(bytes))).toEqual(
		await verifyVideoFile(await file(h264Aac())),
	);
});

test("C2PA boxes with 64-bit headers and one of exactly 1 MiB verify", async () => {
	for (const credentials of [
		c2paBox(4096, { wideBox: true }),
		c2paBox(4096, { wideStore: true }),
		c2paBox(contentCredentialsByteLimit),
	])
		expect(await verifyVideoFile(await file(afterFileType(h264Aac(), credentials)))).toMatchObject({
			duration: 2,
		});
});

/** A 4 KiB C2PA box cut to `size` bytes, its store resized to fill what is left. */
function cutC2pa(size: number) {
	const out = Buffer.from(c2paBox(4096).subarray(0, size));
	out.writeUInt32BE(size, 0);
	if (size >= 49) out.writeUInt32BE(size - 45, 45);
	return out;
}

test("every other uuid and every misframed or misplaced C2PA box is refused", async () => {
	const source = h264Aac();
	const shaped = (shape: ContentCredentialsShape) => afterFileType(source, c2paBox(4096, shape));
	const xmp = "be7acfcb97a942e89c71999491e3afac";
	// ftyp, moov, C2PA, free, mdat: the box arrives too late for chunk offsets to move.
	const movieEnd = 32 + topLevelBox(source, "moov").length;
	const afterMovie = Buffer.concat([
		source.subarray(0, movieEnd),
		c2paBox(4096),
		source.subarray(movieEnd),
	]);
	const cases: [string, Buffer, RegExp][] = [
		["XMP", shaped({ extendedType: xmp }), /uuid at the top level/],
		["merkle", shaped({ purpose: "merkle" }), /content credentials purpose/],
		["update", shaped({ purpose: "update" }), /content credentials purpose/],
		["original", shaped({ purpose: "original" }), /content credentials purpose/],
		["version 1", shaped({ versionFlags: 0x0100_0000 }), /content credentials version/],
		["flags 1", shaped({ versionFlags: 1 }), /content credentials version/],
		["Merkle offset", shaped({ merkleOffset: 1n }), /content credentials Merkle offset/],
		["non-jumb", shaped({ storeBox: "free" }), /content credentials store\./],
		[
			"store type",
			shaped({ storeType: "6332706100110010800000aa00389b72" }),
			/content credentials description/,
		],
		["label", shaped({ label: "c2pb" }), /content credentials description/],
		["toggles", shaped({ toggles: 7 }), /content credentials description/],
		["jumb size 0", shaped({ storeSize: 0 }), /content credentials store size/],
		["40 bytes", afterFileType(source, cutC2pa(40)), /box is too short/],
		["82 bytes", afterFileType(source, cutC2pa(82)), /content credentials store size/],
		["trailing", shaped({ storeSize: 4096 - 45 - 8 }), /store must fill its box/],
		["overrun", shaped({ storeSize: 4096 - 45 + 8 }), /store must fill its box/],
		[
			"1 MiB + 1",
			afterFileType(source, c2paBox(contentCredentialsByteLimit + 1)),
			/content credentials over 1 MiB/,
		],
		[
			"second box",
			afterFileType(source, c2paBox(4096), c2paBox(4096)),
			/one content credentials box/,
		],
		["after moov", afterMovie, /content credentials position/],
		["after mdat", Buffer.concat([source, c2paBox(4096)]), /content credentials position/],
		["before ftyp", Buffer.concat([c2paBox(4096), source]), /content credentials position/],
	];
	for (const [label, bytes, reason] of cases) {
		const error = await refusal(bytes);
		expect(error, label).toBeInstanceOf(UnsupportedVideoError);
		expect(error.message, label).toMatch(reason);
	}
});

test("a file that ends inside the C2PA box is truncated", async () => {
	expect(await refusal(h3MaxShape().subarray(0, 32 + 5000))).toBeInstanceOf(TruncatedVideoError);
});

test("a 1 MiB C2PA box and a 60 MiB mdat verify with under 64 KiB read", async () => {
	const reads = await readsOfGrown(afterFileType(h264Aac(), c2paBox(contentCredentialsByteLimit)));
	expect(Math.max(...reads)).toBeLessThanOrEqual(movieByteLimit);
	expect(reads.reduce((a, b) => a + b, 0)).toBeLessThan(64 * 1024);
});
