import { describe, expect, test } from "bun:test";
import { crc32, deflateSync, inflateSync } from "node:zlib";
import sharp from "sharp";
import { invalidCurves, validCurves, withRedCurve } from "./icc-curves.fixture";
import { exifTool, inspectCleanup } from "./metadata-inspection.fixture";
import { cleanPng, PngCleanupError } from "./png";

const signature = Buffer.from("89504e470d0a1a0a", "hex");
const chromaticities = Buffer.from(
	"00007a26000080840000fa00000080e8000075300000ea6000003a9800001770",
	"hex",
);

function chunk(type: string, data = Buffer.alloc(0)) {
	const result = Buffer.alloc(data.length + 12);
	result.writeUInt32BE(data.length);
	result.write(type, 4, "ascii");
	result.set(data, 8);
	result.writeUInt32BE(crc32(result.subarray(4, -4)), result.length - 4);
	return result;
}

function header(width = 1, height = 1, depth = 8, color = 2, interlace = 0) {
	const data = Buffer.alloc(13);
	data.writeUInt32BE(width);
	data.writeUInt32BE(height, 4);
	data.set([depth, color, 0, 0, interlace], 8);
	return chunk("IHDR", data);
}

function png(...encoded: Buffer[]) {
	return Buffer.concat([signature, ...encoded, chunk("IEND")]);
}

function pixels(rows: number[] = [0, 7, 89, 231]) {
	return chunk("IDAT", deflateSync(Buffer.from(rows)));
}

function readChunks(bytes: Uint8Array) {
	const pngBytes = Buffer.from(bytes);
	expect(pngBytes.subarray(0, 8)).toEqual(signature);
	const chunks = new Map<string, Buffer>();
	for (let offset = 8; offset < pngBytes.length; ) {
		const end = offset + 8 + pngBytes.readUInt32BE(offset);
		expect(pngBytes.readUInt32BE(end)).toBe(crc32(pngBytes.subarray(offset + 4, end)));
		chunks.set(
			pngBytes.toString("ascii", offset + 4, offset + 8),
			pngBytes.subarray(offset + 8, end),
		);
		offset = end + 4;
	}
	return chunks;
}

function exif(orientations: number[], littleEndian = true, artistType = 2) {
	const data = Buffer.alloc(14 + orientations.length * 12 + 12);
	const write16 = littleEndian ? data.writeUInt16LE.bind(data) : data.writeUInt16BE.bind(data);
	const write32 = littleEndian ? data.writeUInt32LE.bind(data) : data.writeUInt32BE.bind(data);
	data.write(littleEndian ? "II" : "MM");
	write16(42, 2);
	write32(8, 4);
	write16(orientations.length + 1, 8);
	for (const [index, orientation] of orientations.entries()) {
		const offset = 10 + index * 12;
		write16(0x0112, offset);
		write16(3, offset + 2);
		write32(1, offset + 4);
		write16(orientation, offset + 8);
	}
	const artist = 10 + orientations.length * 12;
	write16(0x013b, artist);
	write16(artistType, artist + 2);
	write32(4, artist + 4);
	data.write("ABC", artist + 8);
	return data;
}

function exifWithThumbnail(thumbnail: Buffer) {
	const main = exif([1]);
	const thumbnailIfd = Buffer.alloc(30);
	main.writeUInt32LE(main.length, main.length - 4);
	thumbnailIfd.writeUInt16LE(2);
	thumbnailIfd.writeUInt16LE(0x0201, 2);
	thumbnailIfd.writeUInt16LE(4, 4);
	thumbnailIfd.writeUInt32LE(1, 6);
	thumbnailIfd.writeUInt32LE(main.length + thumbnailIfd.length, 10);
	thumbnailIfd.writeUInt16LE(0x0202, 14);
	thumbnailIfd.writeUInt16LE(4, 16);
	thumbnailIfd.writeUInt32LE(1, 18);
	thumbnailIfd.writeUInt32LE(thumbnail.length, 22);
	return Buffer.concat([main, thumbnailIfd, thumbnail]);
}

function profileChunk(profile: Buffer, name = "private device name") {
	return chunk("iCCP", Buffer.concat([Buffer.from(`${name}\0\0`), deflateSync(profile)]));
}

function xmpChunk(properties: string, compressed = false) {
	const text = Buffer.from(
		`<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">${properties}</rdf:RDF>`,
	);
	return chunk(
		"iTXt",
		Buffer.concat([
			Buffer.from(compressed ? "XML:com.adobe.xmp\0\x01\0\0\0" : "XML:com.adobe.xmp\0\0\0\0\0"),
			compressed ? deflateSync(text) : text,
		]),
	);
}

async function profileFixture() {
	const image = await sharp({ create: { width: 1, height: 1, channels: 3, background: "red" } })
		.withIccProfile("srgb")
		.png()
		.toBuffer();
	const iccp = readChunks(image).get("iCCP");
	if (!iccp) throw new Error("Missing synthetic ICC profile.");
	const profile = inflateSync(iccp.subarray(iccp.indexOf(0) + 2));
	profile.write("MAKE", 48);
	profile.writeUInt16BE(2025, 24);
	profile.write("TEST", 80);
	for (let entry = 132; entry < 132 + 12 * profile.readUInt32BE(128); entry += 12) {
		const signature = profile.toString("ascii", entry, entry + 4);
		if (signature === "cprt" || signature === "desc") {
			const text = Buffer.from(signature === "cprt" ? "Own" : "Desk", "utf16le").swap16();
			const offset = profile.readUInt32BE(entry + 4);
			profile.writeUInt32BE(text.length, offset + 20);
			text.copy(profile, offset + 28);
		}
	}
	return profile;
}

async function expectFailure(bytes: Uint8Array, code: PngCleanupError["code"]) {
	try {
		await cleanPng(bytes);
	} catch (error) {
		expect(error).toBeInstanceOf(PngCleanupError);
		if (!(error instanceof PngCleanupError)) throw error;
		expect(error.code).toBe(code);
		expect(error.message).toBeTruthy();
		expect(error.guidance).toBeTruthy();
		expect(error.message + error.guidance).not.toContain("PRIVATE_MARKER");
		expect(error.cause).toBeUndefined();
		return;
	}
	throw new Error("Expected PNG cleanup to decline the fixture.");
}

describe("cleanPng", () => {
	test.skipIf(exifTool === undefined)(
		"preserves image data and ICC while independently removing compressed author and EXIF tags",
		async () => {
			const profile = await profileFixture();
			const source = png(
				header(),
				profileChunk(profile),
				chunk(
					"zTXt",
					Buffer.concat([Buffer.from("Author\0\0"), deflateSync(Buffer.from("private author"))]),
				),
				chunk("eXIf", exif([1])),
				pixels(),
			);
			await inspectCleanup("png", source, cleanPng, (inspect) => {
				const tags = ["-s3", "-n", "-Author", "-Artist", "-Orientation"];
				const before = inspect("source", ...tags).toString();
				expect(before).toContain("private author");
				expect(before).toContain("ABC");
				expect(inspect("cleaned", ...tags).toString()).toBe("");
				expect(inspect("source", "-ICC_Profile", "-b")).toEqual(profile);
				expect(inspect("cleaned", "-ICC_Profile", "-b")).toEqual(profile);
				const imageHash = inspect("source", "-s3", "-ImageDataHash");
				expect(imageHash.toString().trim()).toMatch(/^[a-f0-9]{32}$/);
				expect(inspect("cleaned", "-s3", "-ImageDataHash")).toEqual(imageHash);
			});
		},
	);

	test("strips descriptive text, EXIF, time and Content Credentials while keeping an untagged image untagged", async () => {
		const marker = Buffer.from("PRIVATE_MARKER");
		const xmp = Buffer.from(
			'<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:Iptc4xmpExt="http://iptc.org/std/Iptc4xmpExt/2008-02-29/" Iptc4xmpExt:DigitalSourceType="PRIVATE_MARKER"/></rdf:RDF>',
		);
		const thumbnail = await sharp({
			create: { width: 1, height: 1, channels: 3, background: "red" },
		})
			.jpeg()
			.toBuffer();
		const comment = Buffer.from([0xff, 0xfe, 0, marker.length + 2]);
		const markedThumbnail = Buffer.concat([
			thumbnail.subarray(0, 2),
			comment,
			marker,
			thumbnail.subarray(2),
		]);
		const input = png(
			header(),
			chunk("eXIf", exifWithThumbnail(markedThumbnail)),
			chunk(
				"iTXt",
				Buffer.concat([Buffer.from("XML:com.adobe.xmp\0\x01\0\0\0"), deflateSync(xmp)]),
			),
			chunk("zTXt", Buffer.concat([Buffer.from("Comment\0\0"), deflateSync(marker)])),
			chunk("caBX", Buffer.concat([Buffer.from("000000086a756d62", "hex"), marker])),
			pixels(),
			chunk("tEXt", Buffer.concat([Buffer.from("Author\0"), marker])),
			chunk("tIME", Buffer.from([7, 234, 4, 5, 1, 2, 3])),
		);
		const original = Buffer.from(input);
		const wrapped = Uint8Array.from([0, ...input, 0]);
		const output = await cleanPng(wrapped.subarray(1, -1));
		expect(output).toEqual(png(header(), pixels()));
		expect(wrapped.subarray(1, -1)).toEqual(Uint8Array.from(original));
	});

	test("preserves the ICC payload and every coexisting color declaration in order", async () => {
		const profile = await profileFixture();
		const cicp = chunk("cICP", Buffer.from([12, 13, 0, 1]));
		const srgb = chunk("sRGB", Buffer.from([1]));
		const gamma = chunk("gAMA", Buffer.from("0000b18f", "hex"));
		const chrm = chunk("cHRM", chromaticities);
		const significant = chunk("sBIT", Buffer.from([7, 7, 7]));
		const aspect = chunk("pHYs", Buffer.from("000000020000000101", "hex"));
		const input = png(
			header(),
			cicp,
			profileChunk(profile),
			srgb,
			gamma,
			chrm,
			significant,
			aspect,
			pixels(),
		);
		const output = await cleanPng(input);
		const chunks = readChunks(output);
		expect([...chunks.keys()]).toEqual([
			"IHDR",
			"cICP",
			"iCCP",
			"sRGB",
			"gAMA",
			"cHRM",
			"sBIT",
			"pHYs",
			"IDAT",
			"IEND",
		]);
		const iccp = chunks.get("iCCP");
		if (!iccp) throw new Error("Missing cleaned ICC profile.");
		expect(iccp.subarray(0, iccp.indexOf(0)).toString()).toBe("ICC");
		expect(inflateSync(iccp.subarray(iccp.indexOf(0) + 2))).toEqual(profile);
		expect(output).toEqual(
			png(
				header(),
				cicp,
				profileChunk(profile, "ICC"),
				srgb,
				gamma,
				chrm,
				significant,
				aspect,
				pixels(),
			),
		);
	});

	test("keeps gamma-only, 16-bit transparency and exact Adam7 filtered samples across split IDAT", async () => {
		const ihdr = header(2, 2, 16, 2, 1);
		const gamma = chunk("gAMA", Buffer.from("000186a0", "hex"));
		const transparency = chunk("tRNS", Buffer.from("100120023003", "hex"));
		// A 2x2 Adam7 image has non-empty passes 1, 6 and 7.
		const raw = Buffer.from("001001200230030010022003300400100320043005100420053006", "hex");
		const compressed = deflateSync(raw);
		const input = png(
			ihdr,
			gamma,
			transparency,
			chunk("IDAT", compressed.subarray(0, 5)),
			chunk("IDAT", compressed.subarray(5)),
		);
		expect(await cleanPng(input)).toEqual(input);
	});

	test("keeps a packed palette and palette transparency", async () => {
		const input = png(
			header(2, 1, 1, 3),
			chunk("PLTE", Buffer.from([10, 20, 30, 40, 50, 60])),
			chunk("tRNS", Buffer.from([0, 190])),
			pixels([0, 0b01000000]),
		);
		expect(await cleanPng(input)).toEqual(input);
	});

	test("cleans Exif 3.0 UTF-8 authorship with upright primary orientation", async () => {
		const input = exif([1], true, 129);
		expect(await cleanPng(png(header(), chunk("eXIf", input), pixels()))).toEqual(
			png(header(), pixels()),
		);
	});

	test.each([2, 129])("strips an empty descriptive EXIF string of type %d", async (type) => {
		const metadata = exif([], true, type);
		metadata.writeUInt32LE(0, 14);
		expect(await cleanPng(png(header(), chunk("eXIf", metadata), pixels()))).toEqual(
			png(header(), pixels()),
		);
	});

	test("ignores a discarded thumbnail's independent orientation", async () => {
		const primary = exif([1]);
		const thumbnail = exif([6]).subarray(8);
		primary.writeUInt32LE(primary.length, primary.length - 4);
		const input = Buffer.concat([primary, thumbnail]);
		expect(await cleanPng(png(header(), chunk("eXIf", input), pixels()))).toEqual(
			png(header(), pixels()),
		);
	});

	test("accepts a big-endian identity EXIF orientation", async () => {
		expect(await cleanPng(png(header(), chunk("eXIf", exif([1], false)), pixels()))).toEqual(
			png(header(), pixels()),
		);
	});

	test.each([
		["non-identity", exif([6])],
		["invalid", exif([0])],
		["duplicated identity", exif([1, 1])],
		["conflicting", exif([1, 8])],
		["unreadable", exif([1]).subarray(0, 16)],
	])("declines %s EXIF orientation", async (_label, data) => {
		await expectFailure(png(header(), chunk("eXIf", data), pixels()), "png-orientation");
	});

	test("declines duplicate or misplaced EXIF chunks", async () => {
		const metadata = chunk("eXIf", exif([1]));
		await expectFailure(png(header(), metadata, metadata, pixels()), "png-orientation");
		await expectFailure(png(header(), pixels(), metadata), "invalid-png");
	});

	test.each([
		["acTL", "animated-png"],
		["fcTL", "animated-png"],
		["fdAT", "animated-png"],
		["gMAP", "hdr-png"],
		["gdAT", "hdr-png"],
		["mDCV", "hdr-png"],
		["cLLI", "hdr-png"],
		["vpAg", "unsupported-png-chunk"],
		["dSIG", "unsupported-png-chunk"],
	] as const)("declines %s chunks without exposing their payload", async (type, code) => {
		await expectFailure(png(header(), chunk(type, Buffer.from("PRIVATE_MARKER")), pixels()), code);
	});

	test.each([16, 18])("declines HDR transfer function %d", async (transfer) => {
		await expectFailure(
			png(header(), chunk("cICP", Buffer.from([9, transfer, 0, 1])), pixels()),
			"hdr-png",
		);
	});

	test("declines a raw EXIF text carrier whose orientation cannot be qualified", async () => {
		await expectFailure(
			png(header(), chunk("tEXt", Buffer.from("Raw profile type exif\0PRIVATE_MARKER")), pixels()),
			"png-orientation",
		);
	});

	test("declines an XMP orientation declaration even when it uses a different namespace prefix", async () => {
		const xmp = xmpChunk(
			'<rdf:Description xmlns:camera="http://ns.adobe.com/tiff/1.0/" camera:Orientation="6"/>',
			true,
		);
		await expectFailure(png(header(), chunk("eXIf", exif([1])), xmp, pixels()), "png-orientation");
	});

	test("cleans descriptive XMP text mentioning Orientation and the HDR namespace", async () => {
		const xmp = xmpChunk(
			'<rdf:Description xmlns:dc="http://purl.org/dc/elements/1.1/">' +
				"<dc:description>See Orientation at http://ns.adobe.com/hdr-gain-map/1.0/</dc:description>" +
				'<!-- camera:Orientation="6" -->' +
				"</rdf:Description>",
			true,
		);
		expect(await cleanPng(png(header(), pixels(), xmp))).toEqual(png(header(), pixels()));
	});

	test.each([
		'<rdf:Description xmlns:camera="http://ns.adobe.com/tiff/1.0/" camera:Orientation="1"/>',
		'<rdf:Description><Orientation xmlns="http://ns.adobe.com/tiff/1.0/">1</Orientation></rdf:Description>',
	])("cleans a single identity XMP orientation", async (property) => {
		expect(await cleanPng(png(header(), xmpChunk(property), pixels()))).toEqual(
			png(header(), pixels()),
		);
	});

	test("declines repeated identity orientation across TIFF and XMP or across XMP packets", async () => {
		const xmp = xmpChunk(
			'<rdf:Description xmlns:camera="http://ns.adobe.com/tiff/1.0/" camera:Orientation="1"/>',
		);
		await expectFailure(png(header(), xmp, chunk("eXIf", exif([1])), pixels()), "png-orientation");
		await expectFailure(png(header(), xmp, pixels(), xmp), "png-orientation");
	});

	test.each([
		'<rdf:Description xmlns:t="http://ns.adobe.com/tiff/1.0/" t:Orientation="0"/>',
		'<rdf:Description xmlns:t="http://ns.adobe.com/tiff/1.0/" t:Orientation="1"><t:Orientation>1</t:Orientation></rdf:Description>',
		'<rdf:Description xmlns:t="http://ns.adobe.com/tiff/1.0/"><t:Orientation rdf:resource="1"/></rdf:Description>',
		'<rdf:Description xmlns="http://ns.adobe.com/tiff/1.0/"><Orientation>6</Orientation></rdf:Description>',
	])("declines invalid, duplicate or transformed XMP orientation", async (property) => {
		await expectFailure(png(header(), xmpChunk(property), pixels()), "png-orientation");
	});

	test("declines XMP gain maps with character references in the namespace URI", async () => {
		const xmp = xmpChunk(
			'<rdf:Description xmlns:gain="http://ns.adobe.com/hdr&#45;gain-map/1.0/" gain:Version="1.0"/>',
		);
		await expectFailure(png(header(), xmp, pixels()), "hdr-png");
	});

	test("declines XMP document types and bounds XML nesting", async () => {
		const dtd = Buffer.from(
			'XML:com.adobe.xmp\0\0\0\0\0<!DOCTYPE x SYSTEM "https://example.invalid/PRIVATE_MARKER"><x/>',
		);
		await expectFailure(png(header(), chunk("iTXt", dtd), pixels()), "invalid-png");
		await expectFailure(
			png(header(), xmpChunk("<x>".repeat(64) + "</x>".repeat(64)), pixels()),
			"png-limit",
		);
	});

	test("declines malformed text and unknown private chunks", async () => {
		await expectFailure(
			png(header(), chunk("iTXt", Buffer.from("Comment\0\0\0\0\0\xff", "latin1")), pixels()),
			"invalid-png",
		);
		await expectFailure(
			png(header(), chunk("prIv", Buffer.from("PRIVATE_MARKER")), pixels()),
			"unsupported-png-chunk",
		);
		await expectFailure(png(header(), chunk("priv"), pixels()), "invalid-png");
	});

	test("returns fixed cancellation feedback before and during preparation", async () => {
		const controller = new AbortController();
		const image = png(header(), pixels());
		const pending = cleanPng(image, { signal: controller.signal });
		controller.abort(new Error("PRIVATE_MARKER"));
		await expect(pending).rejects.toMatchObject({ name: "PngCleanupError", code: "cancelled" });
		await expect(cleanPng(image, { signal: controller.signal })).rejects.toMatchObject({
			code: "cancelled",
			message: "PNG preparation was cancelled.",
		});
	});

	test("declines HDR signaling carried inside an ICC profile", async () => {
		const profile = await profileFixture();
		const tagOffset = profile.readUInt32BE(136);
		profile.write("cicp", 132);
		profile.writeUInt32BE(12, 140);
		profile.write("cicp", tagOffset);
		profile.set([9, 18, 0, 1], tagOffset + 8);
		await expectFailure(png(header(), profileChunk(profile), pixels()), "hdr-png");
	});

	test.each(invalidCurves)("declines an ICC curve with %s", async (_, curve) => {
		const profile = withRedCurve(await profileFixture(), curve);
		await expectFailure(png(header(), profileChunk(profile), pixels()), "png-color");
	});

	test.each(validCurves)("keeps an ICC curve with %s byte-identical", async (_, curve) => {
		const profile = withRedCurve(await profileFixture(), curve);
		const output = await cleanPng(png(header(), profileChunk(profile), pixels()));
		const packed = readChunks(output).get("iCCP");
		expect(packed?.subarray(0, 5)).toEqual(Buffer.from("ICC\0\0"));
		if (!packed) throw new Error("Missing ICC profile");
		expect(inflateSync(packed.subarray(5))).toEqual(profile);
	});

	test.each(["wtpt", "desc", "rTRC"])(
		"declines an invalid required ICC tag payload at %s",
		async (tag) => {
			const profile = await profileFixture();
			const entry = profile.indexOf(tag, 132, "ascii");
			expect(entry).toBeGreaterThanOrEqual(132);
			const offset = profile.readUInt32BE(entry + 4);
			if (tag === "wtpt") profile.fill(0, offset + 8, offset + 20);
			if (tag === "desc") profile.writeUInt32BE(8, entry + 8);
			if (tag === "rTRC") {
				expect(profile.readUInt16BE(offset + 8)).toBe(3);
				profile.writeInt32BE(-65536, offset + 20);
			}
			await expectFailure(png(header(), profileChunk(profile), pixels()), "png-color");
		},
	);

	test.each(["rXYZ", "rTRC"])("declines an unusable RGB display transform at %s", async (tag) => {
		const profile = await profileFixture();
		const entry = profile.indexOf(tag, 132, "ascii");
		expect(entry).toBeGreaterThanOrEqual(132);
		if (tag === "rXYZ") {
			profile.write("test", entry, "ascii");
		} else {
			const curve = profile.readUInt32BE(entry + 4);
			expect(profile.toString("ascii", curve, curve + 4)).toBe("para");
			profile.writeUInt16BE(7, curve + 8);
		}
		await expectFailure(png(header(), profileChunk(profile), pixels()), "png-color");
	});

	test("declines overlapping ICC tag data and unknown ICC versions", async () => {
		const profile = await profileFixture();
		profile.writeUInt32BE(profile.readUInt32BE(136) + 4, 148);
		await expectFailure(png(header(), profileChunk(profile), pixels()), "png-color");
		profile[8] = 5;
		await expectFailure(png(header(), profileChunk(profile), pixels()), "png-color");
	});

	test("declines broken ICC streams and mismatched profile color space", async () => {
		const profile = await profileFixture();
		const packed = Buffer.concat([
			Buffer.from("ICC\0\0"),
			deflateSync(profile),
			Buffer.from("PRIVATE_MARKER"),
		]);
		await expectFailure(png(header(), chunk("iCCP", packed), pixels()), "png-color");
		await expectFailure(
			png(header(1, 1, 8, 0), profileChunk(profile), pixels([0, 23])),
			"png-color",
		);
	});

	test("declines bad CRCs, non-consecutive IDAT, malformed palette and late color tags", async () => {
		const corrupted = chunk("tEXt", Buffer.from("Comment\0PRIVATE_MARKER"));
		corrupted[8] ^= 1;
		const text = chunk("tEXt", Buffer.from("Comment\0PRIVATE_MARKER"));
		await expectFailure(png(header(), corrupted, pixels()), "invalid-png");
		await expectFailure(png(header(), pixels(), text, chunk("IDAT")), "invalid-png");
		await expectFailure(
			png(header(1, 1, 1, 3), chunk("PLTE", Buffer.from([1, 2, 3, 4])), pixels([0, 0])),
			"invalid-png",
		);
		await expectFailure(
			png(header(), pixels(), chunk("gAMA", Buffer.from("0000b18f", "hex"))),
			"invalid-png",
		);
	});

	test("declines trailing images and bytes in the same or subsequent IDAT after zlib ends", async () => {
		const input = png(header(), pixels());
		await expectFailure(Buffer.concat([input, input]), "trailing-png-data");
		const combined = Buffer.concat([
			deflateSync(Buffer.from([0, 0, 0, 0])),
			Buffer.from("PRIVATE_MARKER"),
		]);
		await expectFailure(png(header(), chunk("IDAT", combined)), "trailing-png-data");
		await expectFailure(
			png(header(), pixels(), chunk("IDAT", deflateSync(Buffer.from([0])))),
			"trailing-png-data",
		);
	});

	test("declines bad filters, wrong decoded lengths and incomplete zlib", async () => {
		await expectFailure(png(header(), pixels([5, 1, 2, 3])), "invalid-png");
		await expectFailure(png(header(), pixels([0, 1, 2])), "invalid-png");
		await expectFailure(png(header(), pixels([0, 1, 2, 3, 4])), "invalid-png");
		await expectFailure(
			png(header(), chunk("IDAT", deflateSync(Buffer.from([0, 1, 2, 3])).subarray(0, -1))),
			"invalid-png",
		);
	});

	test("declines excessive dimensions, ICC expansion and aggregate text expansion", async () => {
		await expectFailure(png(header(16385), pixels()), "png-limit");
		await expectFailure(png(header(4000, 2001), pixels()), "png-limit");
		await expectFailure(
			png(header(), profileChunk(Buffer.alloc(1024 * 1024 + 1)), pixels()),
			"png-limit",
		);
		const text = chunk(
			"zTXt",
			Buffer.concat([Buffer.from("Comment\0\0"), deflateSync(Buffer.alloc(3 * 1024 * 1024, 65))]),
		);
		await expectFailure(png(header(), text, text, pixels()), "png-limit");
		const translatedKeyword = chunk(
			"iTXt",
			Buffer.concat([
				Buffer.from("Comment\0\0\0de\0"),
				Buffer.alloc(4 * 1024 * 1024, 65),
				Buffer.from([0]),
			]),
		);
		await expectFailure(png(header(), translatedKeyword, pixels()), "png-limit");
	});

	test("declines an indexed image with a sample outside its palette", async () => {
		await expectFailure(
			png(header(1, 1, 1, 3), chunk("PLTE", Buffer.from([1, 2, 3])), pixels([0, 0x80])),
			"invalid-png",
		);
	});

	test.each([1, 2, 3, 4])("checks palette indices after undoing filter %d", async (filter) => {
		const palette = chunk("PLTE", Buffer.from([1, 2, 3, 4, 5, 6]));
		const layout = header(2, 2, 8, 3);
		const first = [0, 1, 1];
		const good = png(
			layout,
			palette,
			pixels([...first, filter, filter === 2 || filter === 4 ? 0 : 1, 0]),
		);
		expect(await cleanPng(good)).toEqual(good);
		const bad = png(
			layout,
			palette,
			pixels([...first, filter, filter === 2 || filter === 4 ? 0 : 1, 1]),
		);
		await expectFailure(bad, "invalid-png");
	});
});
