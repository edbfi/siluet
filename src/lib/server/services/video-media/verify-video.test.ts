import { afterAll, expect, spyOn, test } from "bun:test";
import { mkdtemp, open, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	appendChild,
	box,
	h264Aac,
	locate,
	payload,
	undecodableH264Aac,
} from "../../../../../tests/fixtures/video/mp4-boxes";
import { TruncatedVideoError, UnsupportedVideoError } from "./errors";
import { movieByteLimit } from "./limits";
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

test("a 60 MiB mdat is checked from headers with at most 4 MiB buffered", async () => {
	const source = h264Aac();
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
