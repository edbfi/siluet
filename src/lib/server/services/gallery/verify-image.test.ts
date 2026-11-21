import { expect, test } from "bun:test";
import { crc32 } from "node:zlib";
import { referencePng } from "../../../../../tests/fixtures/reference-image";
import { verifyImage } from "./verify-image";

const jpeg = await new Bun.Image(referencePng).jpeg().buffer();

test("decodes original PNG and JPEG pixels", async () => {
	expect(await verifyImage(referencePng)).toEqual({ mime: "image/png", width: 1, height: 1 });
	expect(await verifyImage(jpeg)).toEqual({ mime: "image/jpeg", width: 1, height: 1 });
});

test("requires complete images, including entropy-coded JPEG data and PNG chunk checksums", async () => {
	const damagedPng = Buffer.from(referencePng);
	damagedPng[47] ^= 1;
	const damagedJpeg = Buffer.concat([jpeg.subarray(0, -8), jpeg.subarray(-2)]);
	for (const bytes of [
		referencePng.subarray(0, -12),
		damagedPng,
		damagedJpeg,
		jpeg.subarray(0, -3),
		Buffer.from("not an image"),
		await new Bun.Image(referencePng).webp().buffer(),
	]) {
		await expect(verifyImage(bytes)).rejects.toThrow();
	}
});

test("checks width, height and decoded area before allocating pixel output", async () => {
	for (const [width, height] of [
		[16385, 1],
		[1, 16385],
		[4001, 4000],
	]) {
		const bytes = Buffer.from(referencePng);
		bytes.writeUInt32BE(width, 16);
		bytes.writeUInt32BE(height, 20);
		bytes.writeUInt32BE(crc32(bytes.subarray(12, 29)), 29);
		await expect(verifyImage(bytes)).rejects.toThrow();
	}
});

test("only one complete JPEG codestream may be published, including progressive scans", async () => {
	const progressive = await new Bun.Image(referencePng).jpeg({ progressive: true }).buffer();
	expect(await verifyImage(progressive)).toMatchObject({ mime: "image/jpeg" });
	await expect(verifyImage(Buffer.concat([progressive, jpeg]))).rejects.toThrow();
});
