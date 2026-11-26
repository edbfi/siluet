import { expect, spyOn, test } from "bun:test";
import { crc32 } from "node:zlib";
import sharp from "sharp";
import { referenceGif, referencePng } from "../../../../../tests/fixtures/reference-image";
import { riffWebp, webpChunks, webpFixtures } from "../../../../../tests/fixtures/webp";
import { verifyImage } from "./verify-image";

const jpeg = await new Bun.Image(referencePng).jpeg().buffer();

test("decodes original PNG and JPEG pixels", async () => {
	expect(await verifyImage(referencePng)).toEqual({ mime: "image/png", width: 1, height: 1 });
	expect(await verifyImage(jpeg)).toEqual({ mime: "image/jpeg", width: 1, height: 1 });
});

test.each(Object.keys((await webpFixtures()).saves))(
	"still WebP (%s) decodes in full and keeps its type",
	async (name) => {
		const bytes = (await webpFixtures()).saves[
			name as keyof Awaited<ReturnType<typeof webpFixtures>>["saves"]
		];
		expect(await verifyImage(bytes)).toEqual({ mime: "image/webp", width: 3, height: 2 });
	},
);

test("Bun's own still WebP saves", async () => {
	const webp = Buffer.from(await new Bun.Image(referencePng).webp().buffer());
	expect(await verifyImage(webp)).toEqual({ mime: "image/webp", width: 1, height: 1 });
});

test.each(Object.keys((await webpFixtures()).held))(
	"WebP the RIFF walk refuses (%s) is held before any decode",
	async (name) => {
		const bytes = (await webpFixtures()).held[
			name as keyof Awaited<ReturnType<typeof webpFixtures>>["held"]
		];
		const metadata = spyOn(Object.getPrototypeOf(sharp()), "metadata");
		try {
			await expect(verifyImage(bytes)).rejects.toMatchObject({ reason: "unsupported-image" });
			expect(metadata).not.toHaveBeenCalled();
		} finally {
			metadata.mockRestore();
		}
	},
);

test.each(Object.keys((await webpFixtures()).truncated))(
	"a truncated WebP (%s) keeps the retrieval outcome",
	async (name) => {
		const bytes = (await webpFixtures()).truncated[
			name as keyof Awaited<ReturnType<typeof webpFixtures>>["truncated"]
		];
		const error = await verifyImage(bytes).catch((reason: unknown) => reason);
		expect(error).toBeInstanceOf(Error);
		expect(error).not.toHaveProperty("reason");
	},
);

test("a multi-page WebP is held even when its chunks look still", async () => {
	const { lossy } = (await webpFixtures()).saves;
	const metadata = spyOn(Object.getPrototypeOf(sharp()), "metadata").mockResolvedValue({
		format: "webp",
		width: 3,
		height: 2,
		pages: 2,
	} as never);
	try {
		await expect(verifyImage(lossy)).rejects.toMatchObject({ reason: "unsupported-image" });
	} finally {
		metadata.mockRestore();
	}
});

test("damaged still WebP pixels keep the retrieval outcome", async () => {
	const pixels = Buffer.alloc(64 * 64 * 3);
	for (let index = 0; index < pixels.length; index++) pixels[index] = (index * 31) & 255;
	const raw = { raw: { width: 64, height: 64, channels: 3 as const } };
	const lossless = Buffer.from(await sharp(pixels, raw).webp({ lossless: true }).toBuffer());
	// Damage the entropy-coded data between the VP8L header and the chunk's pad byte.
	const end = 20 + lossless.readUInt32LE(16);
	for (let index = 25; index < end; index++) lossless[index] ^= 0x5a;
	// libwebp decodes damaged lossy data without an error, but not a partition cut in half
	// inside a container whose sizes still agree.
	const [vp8] = webpChunks(await sharp(pixels, raw).webp().toBuffer());
	const halved = riffWebp([{ type: "VP8 ", data: vp8.data.subarray(0, vp8.data.length >> 1) }]);
	for (const bytes of [lossless, halved]) {
		const error = await verifyImage(bytes).catch((reason: unknown) => reason);
		expect(error).toBeInstanceOf(Error);
		expect(error).not.toHaveProperty("reason");
	}
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

test("Save identifies complete images outside the Gallery profile with a bounded reason", async () => {
	const image = sharp(referencePng);
	const wide = await sharp({
		create: { width: 16385, height: 1, channels: 3, background: "#103254" },
	})
		.png()
		.toBuffer();
	const large = await sharp({
		create: { width: 4001, height: 4000, channels: 3, background: "#103254" },
	})
		.jpeg()
		.toBuffer();
	for (const bytes of [
		(await webpFixtures()).held.animated,
		referenceGif,
		await image.avif().toBuffer(),
		await image.tiff().toBuffer(),
		wide,
		large,
	]) {
		await expect(verifyImage(bytes)).rejects.toMatchObject({ reason: "unsupported-image" });
	}
});

test("incomplete or damaged pixels retain the ordinary retrieval outcome", async () => {
	const webp = await sharp(referencePng).webp().toBuffer();
	const truncated = Buffer.from(webp.subarray(0, -6));
	truncated.writeUInt32LE(truncated.length - 8, 4);
	const wrongWidth = Buffer.from(referencePng);
	wrongWidth.writeUInt32BE(16385, 16);
	wrongWidth.writeUInt32BE(crc32(wrongWidth.subarray(12, 29)), 29);
	for (const bytes of [
		truncated,
		wrongWidth,
		referenceGif.subarray(0, -1),
		referencePng.subarray(0, -12),
		Buffer.from("expired response"),
	]) {
		const error: unknown = await verifyImage(bytes).catch((reason: unknown) => reason);
		expect(error).toBeInstanceOf(Error);
		expect(error).not.toHaveProperty("reason");
	}
});

test("an oversized header and end marker alone cannot identify a complete Gallery result", async () => {
	const png = Buffer.concat([referencePng.subarray(0, 33), referencePng.subarray(-12)]);
	png.writeUInt32BE(4001, 16);
	png.writeUInt32BE(4000, 20);
	png.writeUInt32BE(crc32(png.subarray(12, 29)), 29);
	const large = await sharp({
		create: { width: 4001, height: 4000, channels: 3, background: "#103254" },
	})
		.jpeg()
		.toBuffer();
	const scan = large.indexOf(Buffer.from([0xff, 0xda]));
	const scanStart = scan + 2 + large.readUInt16BE(scan + 2);
	const emptyScan = Buffer.concat([large.subarray(0, scanStart), large.subarray(-2)]);
	for (const bytes of [png, emptyScan]) {
		const error: unknown = await verifyImage(bytes).catch((reason: unknown) => reason);
		expect(error).toBeInstanceOf(Error);
		expect(error).not.toHaveProperty("reason");
	}
});

test("a complete WebP just above the Gallery pixel limit has a durable reason", async () => {
	const webp = await sharp({
		create: { width: 4001, height: 4000, channels: 3, background: "#103254" },
	})
		.webp({ lossless: true, effort: 0 })
		.toBuffer();
	await expect(verifyImage(webp)).rejects.toMatchObject({ reason: "unsupported-image" });
});

test("oversized PNG dimensions and valid CRCs cannot vouch for damaged pixel data", async () => {
	const png = Buffer.from(referencePng);
	png.writeUInt32BE(4001, 16);
	png.writeUInt32BE(4000, 20);
	png.writeUInt32BE(crc32(png.subarray(12, 29)), 29);
	const error = await verifyImage(png).catch((reason: unknown) => reason);
	expect(error).toBeInstanceOf(Error);
	expect(error).not.toHaveProperty("reason");
});

test("a complete image beyond the verification budget keeps the retrieval outcome", async () => {
	const png = await sharp({
		create: { width: 5000, height: 4001, channels: 3, background: "#103254" },
	})
		.png()
		.toBuffer();
	const error = await verifyImage(png).catch((reason: unknown) => reason);
	expect(error).toBeInstanceOf(Error);
	expect(error).not.toHaveProperty("reason");
});

test("Save keeps its retrieval outcome when a GIF frame or an AVIF box is incomplete", async () => {
	const avif = await sharp(referencePng).avif().toBuffer();
	const partialBox = Buffer.from([0, 0, 0, 12, 109, 100, 97, 116, 0]);
	const gif = Buffer.from(referenceGif);
	// The last one-pixel frame has its data and trailer, but lacks its LZW end code.
	gif[gif.length - 4] = 4;
	for (const bytes of [gif, Buffer.concat([avif, partialBox])]) {
		const error = await verifyImage(bytes).catch((reason: unknown) => reason);
		expect(error).toBeInstanceOf(Error);
		expect(error).not.toHaveProperty("reason");
	}
});

test("Save recognizes a complete GIF across dictionary widths and data sub-blocks", async () => {
	const pixels = Buffer.alloc(128 * 128 * 3);
	for (let index = 0; index < pixels.length; index++)
		pixels[index] = (index * 47 + Math.floor(index / 149)) & 255;
	const gif = await sharp(pixels, { raw: { width: 128, height: 128, channels: 3 } })
		.gif()
		.toBuffer();
	expect(gif.length).toBeGreaterThan(1024);
	await expect(verifyImage(gif)).rejects.toMatchObject({ reason: "unsupported-image" });
});

test.each(["regular", "extended", "to EOF"])(
	"HEIF %s UUID boxes need their complete user type",
	async (form) => {
		const avif = await sharp(referencePng).avif().toBuffer();
		for (const userTypeSize of [0, 15, 16]) {
			const header = form === "extended" ? 16 : 8;
			const box = Buffer.alloc(header + userTypeSize);
			box.write("uuid", 4);
			box.writeUInt32BE(form === "regular" ? box.length : form === "extended" ? 1 : 0);
			if (form === "extended") box.writeBigUInt64BE(BigInt(box.length), 8);
			const error = await verifyImage(Buffer.concat([avif, box])).catch((error: unknown) => error);
			expect(error).toBeInstanceOf(Error);
			if (userTypeSize === 16) expect(error).toHaveProperty("reason", "unsupported-image");
			else expect(error).not.toHaveProperty("reason");
		}
	},
);

test("decodes under a 5 s libvips timeout with the operation cache off", async () => {
	const prototype = Object.getPrototypeOf(sharp());
	const timeout = spyOn(prototype, "timeout");
	try {
		await verifyImage(referencePng);
		await verifyImage(jpeg);
		await verifyImage((await webpFixtures()).saves.lossless);
		expect(timeout.mock.calls).toEqual([[{ seconds: 5 }], [{ seconds: 5 }], [{ seconds: 5 }]]);
	} finally {
		timeout.mockRestore();
	}
	// Alone in a process, so no other module has turned the cache off first.
	const child = Bun.spawnSync([
		process.execPath,
		"-e",
		`await import(${JSON.stringify(`${import.meta.dir}/verify-image.ts`)});
		const { memory, files, items } = (await import("sharp")).default.cache();
		console.log(JSON.stringify([memory.max, files.max, items.max]));`,
	]);
	expect(child.stdout.toString().trim()).toBe("[0,0,0]");
});

test("an image outside the Gallery profile decodes once, under the timeout, to one byte a pixel", async () => {
	const prototype = Object.getPrototypeOf(sharp());
	// 16-bit RGBA, one pixel wider than the Gallery allows.
	const width = 16385;
	const pixels = Buffer.alloc(width * 2 * 4, 200);
	const rgba16 = await sharp(pixels, { raw: { width, height: 2, channels: 4 } })
		.toColourspace("rgb16")
		.png()
		.toBuffer();
	expect((await sharp(rgba16).metadata()).depth).toBe("ushort");
	const stats = spyOn(prototype, "stats");
	const timeout = spyOn(prototype, "timeout");
	const toBuffer = spyOn(prototype, "toBuffer");
	try {
		await expect(verifyImage(rgba16)).rejects.toMatchObject({ reason: "unsupported-image" });
		expect(stats).not.toHaveBeenCalled();
		expect(timeout.mock.calls).toEqual([[{ seconds: 5 }]]);
		expect(toBuffer).toHaveBeenCalledTimes(1);
		const output: Buffer = await toBuffer.mock.results[0].value;
		expect(output.length).toBe(width * 2);
	} finally {
		for (const spy of [stats, timeout, toBuffer]) spy.mockRestore();
	}
});
