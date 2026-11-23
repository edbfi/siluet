import { describe, expect, test } from "bun:test";
import { deflateSync } from "node:zlib";
import sharp, { type SharpOptions } from "sharp";
import { JpegCleanupError } from "./jpeg-errors";
import { verifyOriginal } from "./original";
import {
	chunk,
	cicpTag,
	gainTag,
	icc,
	iccp,
	iccSegments,
	ihdr,
	jpeg,
	lutTag,
	png,
	pngSignature,
	restartJpeg,
	segment,
	withSegments,
} from "./original.fixture";
import { cleanPng } from "./png";
import { PngCleanupError } from "./png-errors";

const signal = new AbortController().signal;
const verify = (bytes: Uint8Array) => verifyOriginal(bytes, { signal });

async function refused(bytes: Uint8Array, code: string) {
	const error = await verify(bytes).then(
		() => null,
		(e: unknown) => e,
	);
	expect(error).toBeInstanceOf(
		bytes[0] === 0xff ? JpegCleanupError : (PngCleanupError as unknown as typeof Error),
	);
	expect((error as { code: string }).code).toBe(code);
	expect(String((error as Error).message)).not.toContain("PRIVATE_MARKER");
}

async function accepted(bytes: Uint8Array) {
	const result = await verify(bytes);
	expect(result.transform).toBe("original");
	expect(Buffer.from(result.bytes).equals(Buffer.from(bytes))).toBe(true);
	return result;
}

const app = (code: number, prefix: string, body = "PRIVATE_MARKER") =>
	segment(code, Buffer.from(`${prefix}${body}`, "latin1"));

describe("an original JPEG", () => {
	test("is refused as a motion photo, appended image or secondary image", async () => {
		const still = await jpeg();
		await refused(
			Buffer.concat([still, Buffer.from("\0\0\0\x18ftypmp42PRIVATE_MARKER")]),
			"trailer",
		);
		await refused(Buffer.concat([still, still]), "trailer");
		await refused(withSegments(still, app(0xe2, "MPF\0")), "secondary");
	});

	test("is refused as Ultra HDR", async () => {
		await refused(withSegments(await jpeg(), app(0xe2, "urn:iso:std:iso:ts:21496:-1\0")), "hdr");
	});

	test("is refused when CMYK", async () => {
		await refused(await jpeg({ cmyk: true }), "unsupported");
	});

	test("is refused when its ICC profile declares PQ or an adaptive gain curve", async () => {
		const still = await jpeg();
		await refused(withSegments(still, ...iccSegments(icc([cicpTag(9, 16)]))), "hdr");
		await refused(withSegments(still, ...iccSegments(icc([lutTag, gainTag]), 64)), "hdr");
	});

	test("is refused when its ICC profile exceeds 1 MiB", async () => {
		const large = icc([lutTag, ["priv", Buffer.alloc(1024 * 1024)]]);
		await refused(withSegments(await jpeg(), ...iccSegments(large)), "limit");
	});

	test("is refused at 65 scans or 4,097 segments", async () => {
		const still = await jpeg();
		const sos = still.indexOf(Buffer.from([0xff, 0xda]));
		const eoi = still.length - 2;
		const scans = Array.from({ length: 65 }, () => still.subarray(sos, eoi));
		await refused(Buffer.concat([still.subarray(0, sos), ...scans, still.subarray(eoi)]), "limit");
		const comments = Array.from({ length: 4_097 }, () => segment(0xfe, Buffer.from("c")));
		await refused(withSegments(still, ...comments), "limit");
	});

	test("is refused when truncated, over an edge or damaged inside the scan", async () => {
		const still = await jpeg();
		await refused(still.subarray(0, still.length - 2), "invalid");
		const wide = await jpeg({ width: 16 });
		const frame = wide.indexOf(Buffer.from([0xff, 0xc0]));
		wide.writeUInt16BE(16_385, frame + 7);
		await refused(wide, "limit");
		const sos = still.indexOf(Buffer.from([0xff, 0xda]));
		const damaged = Buffer.concat([still.subarray(0, sos + 16), Buffer.from([0xff, 0xd9])]);
		await refused(damaged, "invalid");
	});

	test("keeps unused tables, arbitrary APPn and COM byte-identical", async () => {
		const extras = [
			app(0xe9, "vendor\0"),
			app(0xe1, "Exif\0\0"),
			segment(0xfe, Buffer.from("PRIVATE_MARKER comment")),
			segment(0xdb, Buffer.concat([Buffer.from([3]), Buffer.alloc(64, 2)])),
			segment(0xc4, Buffer.from([0x13, 1, ...Array.from({ length: 15 }, () => 0), 0])),
		];
		const result = await accepted(withSegments(await jpeg(), ...extras));
		expect(result.rotated).toBe(false);
	});

	test("keeps an ICC profile the cleaner would refuse", async () => {
		await accepted(withSegments(await jpeg(), ...iccSegments(icc([lutTag]))));
	});

	test("keeps 5,000 restart markers, which are not segments", async () => {
		await accepted(restartJpeg(100, 51));
	});

	test("reports a declared rotation", async () => {
		expect((await accepted(await jpeg({ orientation: 6 }))).rotated).toBe(true);
		expect((await accepted(await jpeg({ orientation: 1 }))).rotated).toBe(false);
	});
});

describe("an original PNG", () => {
	test.each([
		["PQ cICP", chunk("cICP", Buffer.from([9, 16, 0, 1])), "hdr-png"],
		["HLG cICP", chunk("cICP", Buffer.from([9, 18, 0, 1])), "hdr-png"],
		["mDCV", chunk("mDCV", Buffer.alloc(24)), "hdr-png"],
		["iCCP with PQ cicp", iccp(icc([cicpTag(9, 16)])), "hdr-png"],
		["iCCP with ADGC", iccp(icc([lutTag, gainTag])), "hdr-png"],
		["oversized iCCP", iccp(Buffer.alloc(1024 * 1024 + 1)), "png-limit"],
		[
			"corrupt iCCP zlib",
			chunk("iCCP", Buffer.from("profile\0\0PRIVATE_MARKER", "latin1")),
			"invalid-png",
		],
		["an iCCP method other than zlib", iccp(icc([lutTag]), 1), "invalid-png"],
		["acTL", chunk("acTL", Buffer.alloc(8)), "animated-png"],
		[
			"an unknown critical chunk",
			chunk("PrIv", Buffer.from("PRIVATE_MARKER")),
			"unsupported-png-chunk",
		],
	] as const)("is refused with %s", async (_label, extra, code) => {
		await refused(png(extra), code);
	});

	test("is refused when truncated, damaged, trailing or over an edge", async () => {
		const file = png();
		await refused(file.subarray(0, file.length - 4), "invalid-png");
		const damaged = Buffer.from(file);
		damaged[damaged.length - 20] ^= 1;
		await refused(damaged, "invalid-png");
		await refused(Buffer.concat([file, Buffer.from("PRIVATE_MARKER")]), "trailing-png-data");
		await refused(Buffer.concat([pngSignature, ihdr(16_385, 1), file.subarray(33)]), "png-limit");
	});

	test("is refused when the decoder warns about the image data", async () => {
		const broken = Buffer.concat([
			pngSignature,
			ihdr(),
			chunk("IDAT", deflateSync(Buffer.from([0, 1, 2]))),
			chunk("IEND"),
		]);
		await refused(broken, "invalid-png");
	});

	test("keeps an iDOT chunk byte-identical", async () => {
		await accepted(png(chunk("iDOT", Buffer.from("PRIVATE_MARKER"))));
	});

	test("keeps a LUT profile the cleaner refuses and an unparseable profile", async () => {
		const lut = png(iccp(icc([lutTag])));
		await expect(cleanPng(lut)).rejects.toBeInstanceOf(PngCleanupError);
		await accepted(lut);
		await accepted(png(iccp(Buffer.from("not a profile PRIVATE_MARKER"))));
	});
});

describe("verification", () => {
	test("refuses a decoder that reports another format", async () => {
		const file = png();
		const decoder = ((input: Buffer, options: SharpOptions) =>
			Object.assign(sharp(input, options), {
				metadata: async () => ({ format: "jpeg", width: 2, height: 2 }),
			})) as unknown as typeof sharp;
		await expect(verifyOriginal(file, { signal, decoder })).rejects.toMatchObject({
			code: "invalid-png",
		});
	});

	test("stops when cancelled", async () => {
		const controller = new AbortController();
		controller.abort();
		await expect(verifyOriginal(png(), { signal: controller.signal })).rejects.toMatchObject({
			code: "cancelled",
		});
		await expect(verifyOriginal(await jpeg(), { signal: controller.signal })).rejects.toMatchObject(
			{ code: "cancelled" },
		);
	});
});
