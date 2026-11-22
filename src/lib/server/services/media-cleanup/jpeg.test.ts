import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { invalidCurves, validCurves, withRedCurve } from "./icc-curves.fixture";
import { cleanJpeg } from "./jpeg";
import { type JpegFrame, jpegMaxBytes, readJpeg } from "./jpeg-markers";
import { compareSamples, encodeOriented, orientationBounds } from "./jpeg-orient";
import { checkXmpColor } from "./jpeg-xmp";
import { exifTool, inspectCleanup } from "./metadata-inspection.fixture";

function segment(marker: number, ...fields: (Buffer | string)[]) {
	const payload = Buffer.concat(fields.map((field) => Buffer.from(field)));
	const header = Buffer.from([0xff, marker, 0, 0]);
	header.writeUInt16BE(payload.length + 2, 2);
	return Buffer.concat([header, payload]);
}

async function clean(bytes: Uint8Array) {
	return Buffer.from((await cleanJpeg(bytes)).bytes);
}

function insert(jpeg: Buffer, ...markers: Buffer[]) {
	return Buffer.concat([jpeg.subarray(0, 2), ...markers, jpeg.subarray(2)]);
}

test("uses the pinned sRGB profile description when XMP names it", () => {
	const known = { srgb: true, names: new Set(["sRGB2014"]) };
	const label: Parameters<typeof checkXmpColor>[0] = new Map([["ICCProfile", "sRGB2014"]]);
	expect(() => checkXmpColor(label, known, undefined)).not.toThrow();
	expect(() => checkXmpColor(label, known, { srgb: false, uncalibrated: true })).toThrow();
});

async function picture(width = 32, height = 48, progressive = false, subsampling = "4:4:4") {
	const data = Buffer.alloc(width * height * 3);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const offset = (y * width + x) * 3;
			data[offset] = 30 + x * 3;
			data[offset + 1] = 20 + y * 3;
			data[offset + 2] = (x * 4 + y * 2) % 200;
		}
	}
	return sharp(data, { raw: { width, height, channels: 3 } })
		.jpeg({
			chromaSubsampling: subsampling,
			progressive,
		})
		.toBuffer();
}

function exif(entries: [number, number][], exifColor?: number, interop?: string) {
	const ifd = Buffer.alloc(6 + 12 * (entries.length + Number(exifColor !== undefined)));
	ifd.writeUInt16LE(entries.length + Number(exifColor !== undefined));
	for (const [index, [tag, value]] of entries.entries()) {
		const offset = 2 + 12 * index;
		ifd.writeUInt16LE(tag, offset);
		ifd.writeUInt16LE(3, offset + 2);
		ifd.writeUInt32LE(1, offset + 4);
		ifd.writeUInt16LE(value, offset + 8);
	}
	const sub = Buffer.alloc(exifColor === undefined ? 0 : interop === undefined ? 18 : 48);
	if (exifColor !== undefined) {
		const offset = 2 + 12 * entries.length;
		ifd.writeUInt16LE(0x8769, offset);
		ifd.writeUInt16LE(4, offset + 2);
		ifd.writeUInt32LE(1, offset + 4);
		ifd.writeUInt32LE(8 + ifd.length, offset + 8);
		Buffer.from([1, 0, 1, 160, 3, 0, 1, 0, 0, 0]).copy(sub);
		sub.writeUInt16LE(exifColor, 10);
		if (interop !== undefined) {
			sub.writeUInt16LE(2);
			Buffer.from("05a0040001000000", "hex").copy(sub, 14);
			sub.writeUInt32LE(8 + ifd.length + 30, 22);
			Buffer.from("01000100020004000000", "hex").copy(sub, 30);
			sub.write(interop, 40, 3, "ascii");
		}
	}
	return segment(0xe1, "Exif\0\0", Buffer.from([73, 73, 42, 0, 8, 0, 0, 0]), ifd, sub);
}

function exifThumbnail(thumbnail: Buffer) {
	const tiff = Buffer.alloc(56);
	// Big-endian IFD0 points to IFD1 with a JPEG-compressed thumbnail.
	Buffer.from("4d4d002a0000000800000000000e0003", "hex").copy(tiff);
	Buffer.from(
		"010300030000000100060000020100040000000100000038020200040000000100000000",
		"hex",
	).copy(tiff, 16);
	tiff.writeUInt32BE(thumbnail.length, 48);
	return segment(0xe1, "Exif\0\0", tiff, thumbnail);
}

function photoshopIptc(value: string, id = 0x0404) {
	const data = Buffer.concat([Buffer.from([0x1c, 2, 80, 0, value.length]), Buffer.from(value)]);
	return photoshopResource(id, data);
}

function photoshopResource(id: number, data: Buffer) {
	const header = Buffer.from([56, 66, 73, 77, 0, 0, 0, 0, 0, 0, 0, 0]);
	header.writeUInt16BE(id, 4);
	header.writeUInt32BE(data.length, 8);
	return segment(0xed, "Photoshop 3.0\0", header, data, Buffer.alloc(data.length % 2));
}

function photoshopResolution(x: number, y: number) {
	const data = Buffer.from("00000000000200010000000000010001", "hex");
	data.writeInt32BE(x * 65536, 0);
	data.writeInt32BE(y * 65536, 8);
	return photoshopResource(0x03ed, data);
}

function photoshopAspect(ratio: number) {
	const data = Buffer.alloc(12);
	data.writeUInt32BE(2);
	data.writeDoubleBE(ratio, 4);
	return photoshopResource(0x0428, data);
}

function xmp(content: string) {
	return segment(0xe1, "http://ns.adobe.com/xap/1.0/\0", content);
}

function c2pa(value: string) {
	const description = Buffer.from(
		"0000001e6a756d646332706100110010800000aa00389b71026332706100",
		"hex",
	);
	const child = Buffer.from("0000000066726565", "hex");
	child.writeUInt32BE(child.length + value.length);
	const body = Buffer.concat([description, child, Buffer.from(value)]);
	const header = Buffer.from("000000006a756d62", "hex");
	header.writeUInt32BE(8 + body.length);
	return [body.subarray(0, 32), body.subarray(32)].map((part, index) =>
		segment(0xeb, Buffer.from([74, 80, 0, 1, 0, 0, 0, index + 1]), header, part),
	);
}

async function fixtureIcc(transfer: number) {
	const tagged = await sharp(await picture())
		.withIccProfile("p3")
		.jpeg()
		.toBuffer();
	const original = (await sharp(tagged).metadata()).icc;
	if (!original) throw new Error("Missing fixture ICC");

	const count = original.readUInt32BE(128);
	const tableEnd = 132 + count * 12;
	const cicp = Buffer.from([99, 105, 99, 112, 0, 0, 0, 0, 12, transfer, 0, 1]);
	const privateTag = Buffer.from("text\0\0\0\0private fixture description\0");
	const tagData = Buffer.concat([cicp, privateTag]);
	const profile = Buffer.concat([
		original.subarray(0, tableEnd),
		Buffer.alloc(24),
		original.subarray(tableEnd),
		Buffer.alloc((4 - (original.length % 4)) % 4),
		tagData,
	]);
	for (let index = 0; index < count; index++) {
		const offset = 136 + index * 12;
		profile.writeUInt32BE(original.readUInt32BE(offset) + 24, offset);
	}
	profile.writeUInt32BE(profile.length, 0);
	profile.write("TEST", 80, "ascii");
	profile.writeUInt16BE(2026, 24);
	profile.writeUInt32BE(count + 2, 128);
	profile.write("cicp", tableEnd, "ascii");
	profile.writeUInt32BE(profile.length - tagData.length, tableEnd + 4);
	profile.writeUInt32BE(cicp.length, tableEnd + 8);
	profile.write("TEST", tableEnd + 12, "ascii");
	profile.writeUInt32BE(profile.length - privateTag.length, tableEnd + 16);
	profile.writeUInt32BE(privateTag.length, tableEnd + 20);
	return profile;
}

const description = [
	'<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">',
	'<rdf:Description xmlns:dc="http://purl.org/dc/elements/1.1/" dc:creator="fixture author &amp; editor"',
	'xmlns:iptc="http://iptc.org/std/Iptc4xmpExt/2008-02-29/"',
	'iptc:DigitalSourceType="http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia"/>',
	"</rdf:RDF>",
].join(" ");
const secret = "fixture author";

describe("cleanJpeg", () => {
	test("removes descriptive metadata and keeps progressive coding bytes and source untouched", async () => {
		const jpeg = await picture(32, 48, true);
		const source = insert(
			jpeg,
			exifThumbnail(insert(await picture(8, 8), segment(0xfe, secret))),
			xmp(description),
			photoshopIptc(secret),
			segment(0xfe, secret),
		);
		const saved = Buffer.from(source);
		expect(Buffer.from(await clean(source))).toEqual(jpeg);
		expect(source).toEqual(saved);
	});

	test("removes nested extended XMP, APP11 C2PA parts and comments after the first scan", async () => {
		const jpeg = await picture(32, 48, true);
		const rel = Buffer.from(description);
		const guid = createHash("md5").update(rel).digest("hex").toUpperCase();
		const size = Buffer.alloc(8);
		size.writeUInt32BE(rel.length);
		const extended = xmp(`<x xmlns:n="http://ns.adobe.com/xmp/note/" n:HasExtendedXMP="${guid}"/>`);
		const part = segment(0xe1, "http://ns.adobe.com/xmp/extension/\0", guid, size, rel);
		const source = insert(jpeg, extended, part, ...c2pa(secret));
		const late = Buffer.concat([
			source.subarray(0, -2),
			segment(0xfe, secret),
			source.subarray(-2),
		]);
		expect(Buffer.from(await clean(late))).toEqual(jpeg);
		await expect(clean(insert(jpeg, segment(0xeb, "JP", secret)))).rejects.toMatchObject({
			code: "metadata",
		});
	});

	test("removes EXIF sRGB and R98 only with a verified equivalent ICC profile", async () => {
		const jpeg = await picture();
		const srgb = await sharp(jpeg).withIccProfile("srgb").jpeg().toBuffer();
		for (const declaration of [exif([], 1), exif([], 1, "R98")]) {
			expect(await clean(insert(srgb, declaration))).toEqual(srgb);
		}
		const p3 = await sharp(jpeg).withIccProfile("p3").jpeg().toBuffer();
		for (const input of [insert(p3, exif([], 1, "R98")), insert(srgb, exif([], 1, "R03"))]) {
			await expect(clean(input)).rejects.toMatchObject({ code: "color" });
		}
	});

	test("requires that co-sited EXIF chroma have no subsampling", async () => {
		const full = await picture();
		const reduced = await picture(32, 48, false, "4:2:0");
		const centered = exif([[0x0213, 1]]);
		const cosited = exif([[0x0213, 2]]);
		expect(await clean(insert(full, cosited))).toEqual(full);
		expect(await clean(insert(reduced, centered))).toEqual(reduced);
		await expect(clean(insert(reduced, cosited))).rejects.toMatchObject({ code: "color" });
	});

	test.each([
		["ADGC", "text"],
		["TEST", "adgc"],
		["HAGC", "text"],
		["TEST", "hagc"],
	])("declines adaptive ICC gain curve signature %s and type %s", async (signature, type) => {
		const profile = await fixtureIcc(13);
		const entry = 132 + (profile.readUInt32BE(128) - 1) * 12;
		profile.write(signature, entry, "ascii");
		profile.write(type, profile.readUInt32BE(entry + 4), "ascii");
		const input = insert(
			await picture(),
			segment(0xe2, "ICC_PROFILE\0", Buffer.from([1, 1]), profile),
		);
		await expect(clean(input)).rejects.toMatchObject({ code: "hdr" });
	});

	test.each(invalidCurves)("declines an ICC curve with %s", async (_, curve) => {
		const profile = withRedCurve(await fixtureIcc(13), curve);
		const input = insert(
			await picture(),
			segment(0xe2, "ICC_PROFILE\0", Buffer.from([1, 1]), profile),
		);
		await expect(clean(input)).rejects.toMatchObject({ code: "color" });
	});

	test.each(validCurves)("keeps an ICC curve with %s byte-identical", async (_, curve) => {
		const profile = withRedCurve(await fixtureIcc(13), curve);
		const input = insert(
			await picture(),
			segment(0xe2, "ICC_PROFILE\0", Buffer.from([1, 1]), profile),
		);
		expect(await clean(input)).toEqual(input);
	});

	test("declines a display ICC profile missing the required media white point", async () => {
		const profile = await fixtureIcc(13);
		const entry = profile.indexOf("wtpt", 132, "ascii");
		expect(entry).toBeGreaterThanOrEqual(132);
		profile.write("test", entry, "ascii");
		const input = insert(
			await picture(),
			segment(0xe2, "ICC_PROFILE\0", Buffer.from([1, 1]), profile),
		);
		await expect(clean(input)).rejects.toMatchObject({ code: "color" });
	});

	test("declines malformed ICC versions, tables and cICP declarations", async () => {
		const jpeg = await picture();
		const profile = await fixtureIcc(13);
		const cicp = 132 + (profile.readUInt32BE(128) - 2) * 12;
		const offset = profile.readUInt32BE(cicp + 4);
		for (const change of [
			(bytes: Buffer) => {
				bytes[8] = 5;
			},
			(bytes: Buffer) => bytes.writeUInt32BE(0, 128),
			(bytes: Buffer) => bytes.writeUInt32BE(offset + 4, cicp + 16),
			(bytes: Buffer) => bytes.write("TEST", cicp, "ascii"),
			(bytes: Buffer) => {
				bytes[offset + 8] = 0;
			},
			(bytes: Buffer) => {
				bytes[offset + 10] = 1;
			},
			(bytes: Buffer) => {
				bytes[offset + 11] = 2;
			},
		]) {
			const altered = Buffer.from(profile);
			change(altered);
			await expect(
				clean(insert(jpeg, segment(0xe2, "ICC_PROFILE\0", Buffer.from([1, 1]), altered))),
			).rejects.toMatchObject({ code: "color" });
		}
	});

	test("keeps multipart ICC and SDR cICP exactly, and strips inline JFIF thumbnails", async () => {
		const jpeg = await picture();
		const icc = await fixtureIcc(13);
		const jfif = Buffer.from("4a46494600010201005a002d0101", "hex");
		const plain = jpeg;
		const source = insert(
			plain,
			segment(0xe0, jfif, Buffer.from([1, 2, 3])),
			segment(0xe2, "ICC_PROFILE\0", Buffer.from([2, 2]), icc.subarray(150)),
			segment(0xe2, "ICC_PROFILE\0", Buffer.from([1, 2]), icc.subarray(0, 150)),
		);
		const cleaned = Buffer.from(await clean(source));
		expect(cleaned.subarray(6, 20)).toEqual(Buffer.concat([jfif.subarray(0, 12), Buffer.alloc(2)]));
		expect((await sharp(cleaned).metadata()).icc).toEqual(icc);
		expect(Buffer.from(await clean(plain))).toEqual(plain);
		const hdrProfile = await fixtureIcc(16);
		await expect(
			clean(insert(jpeg, segment(0xe2, "ICC_PROFILE\0", Buffer.from([1, 1]), hdrProfile))),
		).rejects.toMatchObject({ code: "hdr" });
	});

	test("preserves the ordering of coexisting Adobe, ICC and JFIF declarations", async () => {
		const jpeg = await picture();
		const adobe = segment(0xee, Buffer.from("41646f626500640000000001", "hex"));
		const profile = segment(0xe2, "ICC_PROFILE\0", Buffer.from([1, 1]), await fixtureIcc(13));
		const jfif = segment(0xe0, Buffer.from("4a46494600010201005a002d0000", "hex"));
		const source = insert(jpeg, jfif, adobe, segment(0xfe, secret), profile);
		expect(await clean(source)).toEqual(insert(jpeg, jfif, adobe, profile));
	});

	test("declines invalid or duplicated orientation and EXIF-only color", async () => {
		const jpeg = await picture();
		for (const markers of [
			[exif([[0x112, 9]])],
			[
				exif([
					[0x112, 1],
					[0x112, 6],
				]),
			],
			[exif([[0x112, 1]]), exif([[0x112, 1]])],
		]) {
			await expect(clean(insert(jpeg, ...markers))).rejects.toMatchObject({
				code: "orientation",
			});
		}
		await expect(clean(insert(jpeg, exif([], 1)))).rejects.toMatchObject({ code: "color" });
	});

	test("removes XMP prose about color, orientation, gain maps and auxiliary media", async () => {
		const jpeg = await picture();
		const packet = [
			'<?xpacket begin=""?>',
			'<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:dc="http://purl.org/dc/elements/1.1/">',
			'<!-- tiff:Orientation="6" and xmlns:q="http://ns.adobe.com/hdr-gain-map/1.0/" -->',
			'<rdf:Description dc:creator="A MotionPhoto author who wrote about orientation, ColorSpace and XResolution">',
			"<dc:title><![CDATA[HDR gainmap, MicroVideo and <ColorSpace>]]></dc:title>",
			"<dc:description>See http://ns.adobe.com/hdr-gain-map/1.0/ and this orientation guide.</dc:description>",
			'</rdf:Description></rdf:RDF><?xpacket end="w"?>',
		].join("");
		expect(await clean(insert(jpeg, xmp(packet)))).toEqual(jpeg);
	});

	test("strips redundant uncalibrated XMP and the embedded wide-gamut profile name", async () => {
		const jpeg = await sharp(await picture())
			.withIccProfile("p3")
			.jpeg()
			.toBuffer();
		const ns =
			'xmlns:e="http://ns.adobe.com/exif/1.0/" xmlns:p="http://ns.adobe.com/photoshop/1.0/"';
		const label = xmp(`<x ${ns} e:ColorSpace="65535" p:ICCProfile="Display P3"/>`);
		expect(await clean(insert(jpeg, label))).toEqual(jpeg);
		await expect(clean(insert(await picture(), label))).rejects.toMatchObject({
			code: "color",
		});
		const wrongProfile = xmp(`<x ${ns} p:ICCProfile="AdobeRGB1998"/>`);
		await expect(clean(insert(jpeg, wrongProfile))).rejects.toMatchObject({ code: "color" });
		const contradictory = xmp(`<x ${ns} e:ColorSpace="65535" p:ICCProfile="sRGB"/>`);
		await expect(clean(insert(jpeg, contradictory))).rejects.toMatchObject({ code: "color" });
	});

	test("strips simple redundant XMP orientation, sRGB and density and declines ambiguous values", async () => {
		const raw = await picture();
		const jpeg = await sharp(raw).withIccProfile("srgb").jpeg().toBuffer();
		const jfif = segment(0xe0, Buffer.from("4a46494600010201005a002d0000", "hex"));
		const namespaces = [
			'xmlns:t="http://ns.adobe.com/tiff/1.0/"',
			'xmlns:e="http://ns.adobe.com/exif/1.0/"',
			'xmlns:p="http://ns.adobe.com/photoshop/1.0/"',
		].join(" ");
		const matched = xmp(
			`<x ${namespaces} t:Orientation="1" e:ColorSpace="1" p:ICCProfile="sRGB IEC61966-2.1" t:XResolution="180/2" t:YResolution="45/1" t:ResolutionUnit="2"/>`,
		);
		expect(await clean(insert(jpeg, jfif, matched))).toEqual(insert(jpeg, jfif));
		expect(
			await clean(insert(jpeg, xmp(`<x ${namespaces}><t:Orientation> 1 </t:Orientation></x>`))),
		).toEqual(jpeg);
		const cases = [
			[insert(jpeg, jfif, matched, exif([[0x112, 1]])), "orientation"],
			[
				insert(
					jpeg,
					xmp(`<x ${namespaces} t:Orientation="1"><t:Orientation>1</t:Orientation></x>`),
				),
				"orientation",
			],
			[
				insert(jpeg, xmp(`<x ${namespaces}><t:Orientation><x>1</x></t:Orientation></x>`)),
				"orientation",
			],
			[insert(jpeg, xmp(`<x ${namespaces} t:Orientation="6"/>`)), "orientation"],
			[insert(raw, xmp(`<x ${namespaces} e:ColorSpace="1"/>`)), "color"],
			[insert(jpeg, xmp(`<x ${namespaces} p:ICCProfile="Display P3"/>`)), "color"],
			[
				insert(
					jpeg,
					jfif,
					xmp(`<x ${namespaces} t:XResolution="180/1" t:YResolution="90/1" t:ResolutionUnit="2"/>`),
				),
				"aspect",
			],
			[
				insert(jpeg, jfif, xmp(`<x ${namespaces} t:XResolution="90/1" t:YResolution="180/1"/>`)),
				"aspect",
			],
			[insert(jpeg, jfif, xmp(`<x ${namespaces} t:XResolution="90/1"/>`)), "aspect"],
			[
				insert(
					jpeg,
					jfif,
					xmp(`<x ${namespaces} t:XResolution="90/1"/>`),
					photoshopResource(0x0424, Buffer.from(`<x ${namespaces} t:YResolution="45/1"/>`)),
				),
				"aspect",
			],
			[
				insert(
					jpeg,
					xmp(`<x ${namespaces} t:Orientation="1"/>`),
					photoshopResource(0x0424, Buffer.from(`<x ${namespaces} t:Orientation="1"/>`)),
				),
				"orientation",
			],
			[
				insert(
					jpeg,
					xmp('<x xmlns:g="http://ns.adobe.com/hdr&#45;gain-map/1.0/" g:Version="1.0"/>'),
				),
				"hdr",
			],
			[insert(jpeg, xmp('<!DOCTYPE x [<!ENTITY e "1">]><x>&e;</x>')), "metadata"],
		] as const;
		for (const [source, code] of cases) {
			await expect(clean(source)).rejects.toMatchObject({ code });
		}
	});

	test("drops Photoshop densities and pixel aspect only when they agree with the retained JFIF", async () => {
		const jpeg = await picture();
		const jfif = segment(0xe0, Buffer.from("4a46494600010201005a002d0000", "hex"));
		const retained = insert(jpeg, jfif);
		const resolution = photoshopResolution(90, 45);
		const aspect = photoshopAspect(0.5);
		expect(await clean(insert(retained, resolution, aspect))).toEqual(retained);
		for (const markers of [
			[photoshopResolution(180, 90)],
			[photoshopAspect(2)],
			[aspect, aspect],
		]) {
			await expect(clean(insert(retained, ...markers))).rejects.toMatchObject({
				code: "aspect",
			});
		}
	});

	test("keeps qualified Adobe grayscale and downsampling flags byte-identical", async () => {
		const jpeg = await sharp(await picture())
			.toColourspace("b-w")
			.jpeg()
			.toBuffer();
		expect(readJpeg(jpeg).frame.components.length).toBe(1);
		const gray = segment(0xee, Buffer.from("41646f626500640000000000", "hex"));
		const flagged = segment(0xee, Buffer.from("41646f626500648000000001", "hex"));
		const source = insert(jpeg, gray);
		expect(await clean(source)).toEqual(source);
		const color = insert(await picture(32, 48, false, "4:2:0"), flagged);
		expect(await clean(color)).toEqual(color);
		for (const data of [
			"41646f626500644000000001",
			"41646f626500640000000101",
			"41646f626500640000000002",
		]) {
			await expect(
				clean(insert(await picture(), segment(0xee, Buffer.from(data, "hex")))),
			).rejects.toMatchObject({ code: "color" });
		}
		await expect(clean(insert(jpeg, flagged))).rejects.toMatchObject({ code: "color" });
	});

	test("drops empty descriptive EXIF strings while qualifying metadata types", async () => {
		const jpeg = await picture();
		const marker = exif([[0x013b, 0]]);
		for (const type of [2, 129]) {
			marker.writeUInt16LE(type, 22);
			marker.writeUInt32LE(0, 24);
			expect(await clean(insert(jpeg, marker))).toEqual(jpeg);
		}
		marker.writeUInt16LE(0, 22);
		await expect(clean(insert(jpeg, marker))).rejects.toMatchObject({ code: "metadata" });
		marker.writeUInt16LE(0x0112, 20);
		marker.writeUInt16LE(3, 22);
		await expect(clean(insert(jpeg, marker))).rejects.toMatchObject({ code: "orientation" });
	});

	test("declines unclassified markers, secondary images, trailers, HDR and motion photos", async () => {
		const jpeg = await picture();
		const cases = [
			[insert(jpeg, segment(0xef, secret)), "metadata"],
			[insert(jpeg, photoshopIptc(secret, 0x0428)), "aspect"],
			[insert(jpeg, segment(0xe2, "MPF\0", secret)), "secondary"],
			[Buffer.concat([insert(jpeg, segment(0xe2, "MPF\0", secret)), jpeg]), "secondary"],
			[Buffer.concat([jpeg, Buffer.from(secret)]), "trailer"],
			[
				insert(jpeg, xmp('<ColorSpace xmlns="http://ns.adobe.com/exif/1.0/">1</ColorSpace>')),
				"color",
			],
			[
				insert(jpeg, xmp('<x xmlns:q="http://ns.adobe.com/hdr-gain-map/1.0/" q:Version="1.0"/>')),
				"hdr",
			],
			[
				insert(
					jpeg,
					xmp('<x xmlns:q="http://ns.google.com/photos/1.0/camera/" q:MotionPhoto="1"/>'),
				),
				"motion",
			],
		] as const;
		for (const [source, code] of cases) {
			const result = clean(source);
			await expect(result).rejects.toMatchObject({ code, advice: expect.any(String) });
			await expect(result).rejects.not.toThrow(secret);
		}
	});

	test("rejects damaged scan data and bounds the encoded input", async () => {
		const jpeg = await picture();
		await expect(
			clean(Buffer.concat([jpeg.subarray(0, -20), jpeg.subarray(-2)])),
		).rejects.toMatchObject({ code: "invalid" });
		await expect(clean(Buffer.alloc(16 * 1024 * 1024 + 1))).rejects.toMatchObject({
			code: "limit",
		});
		const oversizedIcc = Array.from({ length: 17 }, (_, i) =>
			segment(0xe2, "ICC_PROFILE\0", Buffer.from([i + 1, 17]), Buffer.alloc(64 * 1024 - 20)),
		);
		await expect(clean(insert(jpeg, ...oversizedIcc))).rejects.toMatchObject({ code: "limit" });
	});

	test("declines bytes hidden between the last scan line and EOI of an upright JPEG", async () => {
		const hidden = Buffer.from(`${secret} hidden after the final MCU of a scan!!`);
		expect(hidden).toHaveLength(53);
		const gray = await sharp(await photo(40, 24))
			.toColourspace("b-w")
			.jpeg()
			.toBuffer();
		const sources = [await photo(64, 40), await photo(37, 29, { subsampling: "4:4:4" }), gray];
		for (const jpeg of sources) {
			for (const source of [jpeg, insert(jpeg, exif([[0x112, 1]]))]) {
				const hiding = Buffer.concat([source.subarray(0, -2), hidden, source.subarray(-2)]);
				const result = cleanJpeg(hiding);
				await expect(result).rejects.toMatchObject({ code: "trailer" });
				await expect(result).rejects.not.toThrow(secret);
				expect(await cleanJpeg(source)).toEqual({ bytes: jpeg, transform: "none" });
			}
		}
		// The decoder reads every progressive scan up to EOI and warns instead.
		const progressive = await picture(32, 48, true);
		await expect(
			cleanJpeg(Buffer.concat([progressive.subarray(0, -2), hidden, progressive.subarray(-2)])),
		).rejects.toMatchObject({ code: "invalid" });
	});
});

const coordinates = (o: number, x: number, y: number, w: number, h: number) =>
	[
		[x, y],
		[w - 1 - x, y],
		[w - 1 - x, h - 1 - y],
		[x, h - 1 - y],
		[y, x],
		[y, h - 1 - x],
		[w - 1 - y, h - 1 - x],
		[w - 1 - y, x],
	][o - 1];

function scene(width: number, height: number, noise = 0) {
	// An asymmetric picture: a bright block near the top-left corner, opposing
	// gradients and a diagonal texture expose any wrong turn or mirror.
	const data = Buffer.alloc(width * height * 3);
	let seed = 7;
	const random = () => {
		seed = (seed * 1103515245 + 12345) >>> 0;
		return seed / 2 ** 32 - 0.5;
	};
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const offset = (y * width + x) * 3;
			const block = x < width / 3 && y < height / 4;
			const values = [block ? 230 : (x * 255) / width, (y * 255) / height, ((x + 2 * y) % 97) * 2];
			for (let c = 0; c < 3; c++) {
				data[offset + c] = Math.max(0, Math.min(255, Math.round(values[c] + random() * noise)));
			}
		}
	}
	return data;
}

async function photo(
	width: number,
	height: number,
	{ noise = 0, quality = 90, subsampling = "4:2:0" } = {},
) {
	return sharp(scene(width, height, noise), { raw: { width, height, channels: 3 } })
		.jpeg({ quality, chromaSubsampling: subsampling })
		.toBuffer();
}

// Score every step-th output pixel against the source pixel it should show.
async function score(source: Buffer, cleaned: Buffer, orientation: number, step = 1) {
	const a = await sharp(source, { ignoreIcc: true }).raw().toBuffer({ resolveWithObject: true });
	const b = await sharp(cleaned, { ignoreIcc: true }).raw().toBuffer({ resolveWithObject: true });
	expect(b.info.channels).toBe(a.info.channels);
	const channels = a.info.channels;
	const expected: number[] = [];
	const actual: number[] = [];
	for (let y = 0; y < b.info.height; y += step) {
		for (let x = 0; x < b.info.width; x += step) {
			const [sx, sy] = coordinates(orientation, x, y, a.info.width, a.info.height);
			for (let c = 0; c < channels; c++) {
				expected.push(a.data[(sy * a.info.width + sx) * channels + c]);
				actual.push(b.data[(y * b.info.width + x) * channels + c]);
			}
		}
	}
	return compareSamples(Uint8Array.from(expected), Uint8Array.from(actual), channels);
}

function withinBounds(result: Awaited<ReturnType<typeof score>>) {
	expect(result.lumaPsnr).toBeGreaterThanOrEqual(orientationBounds.lumaPsnr);
	expect(result.lumaP999).toBeLessThanOrEqual(orientationBounds.lumaP999);
	expect(result.rgbPsnr).toBeGreaterThanOrEqual(orientationBounds.rgbPsnr);
}

const sampling = (bytes: Buffer) => readJpeg(bytes, { maxBytes: 30_000_000 }).frame.components;
const orientations = [2, 3, 4, 5, 6, 7, 8];

function grayProfile() {
	const text = (type: string, value: string) =>
		Buffer.concat([Buffer.from(`${type}\0\0\0\0`, "latin1"), Buffer.from(`${value}\0`, "ascii")]);
	const name = Buffer.from("Fixture Gray\0", "ascii");
	const desc = Buffer.alloc(12 + name.length + 8 + 70);
	desc.write("desc", 0, "latin1");
	desc.writeUInt32BE(name.length, 8);
	name.copy(desc, 12);
	const white = Buffer.from("58595a2000000000" + "0000f6d6000100000000d32d", "hex");
	const curve = Buffer.from("6375727600000000000000010233", "hex");
	const elements: [string, Buffer][] = [
		["desc", desc],
		["cprt", text("text", "No copyright, fixture")],
		["wtpt", white],
		["kTRC", curve],
	];
	const header = Buffer.alloc(132 + elements.length * 12);
	const padded = elements.map(([, data]) =>
		Buffer.concat([data, Buffer.alloc((4 - (data.length % 4)) % 4)]),
	);
	let offset = header.length;
	for (const [index, [tag, data]] of elements.entries()) {
		header.write(tag, 132 + index * 12, "latin1");
		header.writeUInt32BE(offset, 136 + index * 12);
		header.writeUInt32BE(data.length, 140 + index * 12);
		offset += padded[index].length;
	}
	header.writeUInt32BE(offset, 0);
	header[8] = 2;
	header[9] = 0x10;
	header.write("mntrGRAYXYZ ", 12, "latin1");
	header.write("acsp", 36, "latin1");
	header.writeUInt32BE(elements.length, 128);
	return Buffer.concat([header, ...padded]);
}

describe("orientation re-encode", () => {
	test("orientations 2–8 within luma/RGB bounds", async () => {
		const fixtures = [
			[await picture(), 1],
			[await picture(31, 49, false, "4:2:0"), 1],
			[await photo(640, 480), 1],
			[await photo(480, 640, { noise: 40, quality: 95, subsampling: "4:4:4" }), 1],
			[await picture(32, 48, true), 1],
		] as const;
		for (const [jpeg, step] of fixtures) {
			for (const orientation of orientations) {
				const cleaned = await cleanJpeg(insert(jpeg, exif([[0x112, orientation]])));
				expect(cleaned.transform).toBe("reencoded-rotation");
				withinBounds(await score(jpeg, cleaned.bytes, orientation, step));
			}
		}
	}, 60_000);

	test.each([
		[4000, 3000, "4:2:0"],
		[3001, 2001, "4:4:4"],
	] as const)(
		"orientations 2–8 of %d×%d %s photos stay within bounds",
		async (width, height, subsampling) => {
			const jpeg = await photo(width, height, { noise: 20, subsampling });
			const [luma, ...chroma] = sampling(jpeg);
			for (const orientation of orientations) {
				const { bytes } = await cleanJpeg(insert(jpeg, exif([[0x112, orientation]])));
				const swap = orientation >= 5;
				expect(readJpeg(bytes).frame).toMatchObject({
					width: swap ? height : width,
					height: swap ? width : height,
				});
				const [outLuma, ...outChroma] = sampling(bytes);
				expect([outLuma.h, outLuma.v]).toEqual([luma.h, luma.v]);
				expect(outChroma.map(({ h, v }) => [h, v])).toEqual(chroma.map(() => [1, 1]));
				withinBounds(await score(jpeg, bytes, orientation, 3));
			}
		},
		180_000,
	);

	test("4:4:4 saturated edge re-encodes 4:4:4 and passes", async () => {
		const width = 64;
		const height = 40;
		const data = Buffer.alloc(width * height * 3);
		for (let y = 0; y < height; y++)
			for (let x = 0; x < width; x++)
				data.set(x < 21 ? [255, 0, 0] : y < 13 ? [0, 0, 255] : [0, 255, 0], (y * width + x) * 3);
		const jpeg = await sharp(data, { raw: { width, height, channels: 3 } })
			.jpeg({ quality: 95, chromaSubsampling: "4:4:4" })
			.toBuffer();
		for (const orientation of [5, 6]) {
			const { bytes } = await cleanJpeg(insert(jpeg, exif([[0x112, orientation]])));
			expect(sampling(bytes).map(({ h, v }) => [h, v])).toEqual([
				[1, 1],
				[1, 1],
				[1, 1],
			]);
			withinBounds(await score(jpeg, bytes, orientation));
		}
	});

	test("odd-width colour-edge flip passes", async () => {
		const width = 33;
		const height = 17;
		const data = Buffer.alloc(width * height * 3);
		for (let y = 0; y < height; y++)
			for (let x = 0; x < width; x++)
				data.set(x < 11 ? [220, 30, 40] : [30, 60, 210], (y * width + x) * 3);
		const jpeg = await sharp(data, { raw: { width, height, channels: 3 } })
			.jpeg({ quality: 92, chromaSubsampling: "4:2:0" })
			.toBuffer();
		const { bytes } = await cleanJpeg(insert(jpeg, exif([[0x112, 2]])));
		expect(readJpeg(bytes).frame).toMatchObject({ width, height });
		withinBounds(await score(jpeg, bytes, 2));
	});

	test("a wrong rotation, mirror or colour interpretation fails verification", async () => {
		const jpeg = await photo(96, 96);
		const source = insert(jpeg, exif([[0x112, 8]]));
		for (const wrong of [6, 5, 7]) {
			await expect(
				cleanJpeg(source, {
					encode: (upright, frame) => encodeOriented(upright, frame, wrong),
				}),
			).rejects.toMatchObject({ code: "verification" });
		}
		const swapped = async (upright: Buffer, frame: JpegFrame) => {
			const { data, info } = await sharp(await encodeOriented(upright, frame, 8))
				.raw()
				.toBuffer({ resolveWithObject: true });
			for (let i = 0; i < data.length; i += 3) data.set([data[i + 2], data[i + 1], data[i]], i);
			return sharp(data, { raw: info }).jpeg({ quality: 95 }).toBuffer();
		};
		await expect(cleanJpeg(source, { encode: swapped })).rejects.toMatchObject({
			code: "verification",
		});
		// Luma alone cannot see lost chroma. The RGB bound must.
		const desaturated = async (upright: Buffer, frame: JpegFrame) => {
			const { data, info } = await sharp(await encodeOriented(upright, frame, 8))
				.raw()
				.toBuffer({ resolveWithObject: true });
			for (let i = 0; i < data.length; i += 3) {
				const y = Math.round(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]);
				data.set([y, y, y], i);
			}
			return sharp(data, { raw: info })
				.jpeg({ quality: 95, chromaSubsampling: "4:4:4" })
				.toBuffer();
		};
		await expect(cleanJpeg(source, { encode: desaturated })).rejects.toMatchObject({
			code: "verification",
		});
	});

	test("P3 rotated samples match ICC-ignored decode, ICC exact", async () => {
		const tagged = await sharp(await photo(120, 80))
			.withIccProfile("p3")
			.jpeg()
			.toBuffer();
		const icc = (await sharp(tagged).metadata()).icc;
		if (!icc) throw new Error("Missing fixture ICC");
		const { bytes } = await cleanJpeg(insert(tagged, exif([[0x112, 6]])));
		expect((await sharp(bytes).metadata()).icc).toEqual(icc);
		withinBounds(await score(tagged, bytes, 6));
	});

	test("non-square density swaps for 5–8", async () => {
		const jpeg = await picture();
		const jfif = segment(0xe0, Buffer.from("4a46494600010201005a002d0000", "hex"));
		for (const orientation of orientations) {
			const { bytes } = await cleanJpeg(insert(jpeg, jfif, exif([[0x112, orientation]])));
			const marker = readJpeg(bytes).markers;
			expect(marker.map(({ code }) => code)).toEqual([0xe0]);
			expect(marker[0].data.subarray(8, 12)).toEqual(
				Buffer.from(orientation >= 5 ? [0, 45, 0, 90] : [0, 90, 0, 45]),
			);
		}
	});

	test("rotated grayscale with gray ICC stays one component", async () => {
		const gray = await sharp(await photo(40, 24))
			.toColourspace("b-w")
			.jpeg()
			.toBuffer();
		const profile = grayProfile();
		const icc = segment(0xe2, "ICC_PROFILE\0", Buffer.from([1, 1]), profile);
		const source = insert(gray, icc, exif([[0x112, 7]]));
		const { bytes } = await cleanJpeg(source);
		expect(readJpeg(bytes).frame.components).toHaveLength(1);
		expect((await sharp(bytes).metadata()).icc).toEqual(profile);
		withinBounds(await score(gray, bytes, 7));
	});

	test("untagged rotated output stays untagged", async () => {
		const jpeg = await picture();
		const { bytes } = await cleanJpeg(insert(jpeg, exif([[0x112, 3]])));
		expect(readJpeg(bytes).markers).toEqual([]);
		expect((await sharp(bytes).metadata()).icc).toBeUndefined();
	});

	test.each([
		["RGB transform 0", "41646f626500640000000000"],
		["YCbCr transform 1", "41646f626500640000000001"],
		["Blend flag", "41646f626500648000000001"],
	])("rotated Adobe %s: output has no APP14, colours match", async (_, data) => {
		const adobe = segment(0xee, Buffer.from(data, "hex"));
		const source = insert(await photo(48, 32), adobe);
		const { bytes } = await cleanJpeg(insert(source, exif([[0x112, 6]])));
		expect(readJpeg(bytes).markers.map(({ code }) => code)).not.toContain(0xee);
		withinBounds(await score(source, bytes, 6));
	});

	test("upright RGB transform 0 and grayscale transform 0 accepted", async () => {
		const rgb = insert(
			await picture(),
			segment(0xee, Buffer.from("41646f626500640000000000", "hex")),
		);
		expect(await clean(rgb)).toEqual(rgb);
		const gray = insert(
			await sharp(await picture())
				.toColourspace("b-w")
				.jpeg()
				.toBuffer(),
			segment(0xee, Buffer.from("41646f626500640000000000", "hex")),
		);
		expect(await clean(gray)).toEqual(gray);
	});

	test("four-component declined", async () => {
		const cmyk = await sharp(await picture())
			.toColourspace("cmyk")
			.jpeg()
			.toBuffer();
		expect(readJpeg.bind(null, cmyk)).toThrow();
		await expect(clean(insert(cmyk, exif([[0x112, 6]])))).rejects.toMatchObject({
			code: "unsupported",
		});
	});

	test("orientation 1 entropy byte-identical", async () => {
		const jpeg = await photo(64, 48);
		const cleaned = await cleanJpeg(insert(jpeg, exif([[0x112, 1]])));
		expect(cleaned.transform).toBe("none");
		expect(cleaned.bytes).toEqual(jpeg);
	});

	test("high-entropy 16 MP rotated: size reported, ≤ 30,000,000", async () => {
		const jpeg = await photo(4000, 4000, { noise: 255, quality: 70, subsampling: "4:4:4" });
		expect(jpeg.length).toBeLessThan(jpegMaxBytes);
		const { bytes } = await cleanJpeg(insert(jpeg, exif([[0x112, 6]])));
		// Larger than the 16 MiB source limit, within ToAPIs' 30,000,000 bytes.
		expect(bytes.length).toBeGreaterThan(jpegMaxBytes);
		expect(bytes.length).toBeLessThanOrEqual(30_000_000);
		const oversized = async () => Buffer.concat([Buffer.alloc(30_000_001)]);
		await expect(
			cleanJpeg(insert(await picture(), exif([[0x112, 6]])), { encode: oversized }),
		).rejects.toMatchObject({ code: "limit" });
	}, 60_000);

	test.skipIf(exifTool === undefined)(
		"ExifTool sees exact ICC and no descriptive tags after a re-encoded rotation",
		async () => {
			const comment = "private JPEG comment";
			const icc = await fixtureIcc(13);
			const source = insert(
				await picture(),
				segment(0xe2, "ICC_PROFILE\0", Buffer.from([1, 1]), icc),
				exif([[0x112, 6]]),
				xmp(description),
				segment(0xfe, comment),
			);
			await inspectCleanup(
				"jpg",
				source,
				async (bytes) => (await cleanJpeg(bytes)).bytes,
				(inspect) => {
					const tags = ["-s3", "-n", "-Orientation", "-Creator", "-DigitalSourceType", "-Comment"];
					const before = inspect("source", ...tags)
						.toString()
						.trim()
						.split(/\r?\n/);
					expect(before).toContain("6");
					expect(before).toContain("fixture author & editor");
					expect(before).toContain(
						"http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia",
					);
					expect(before).toContain(comment);
					expect(inspect("cleaned", ...tags).toString()).toBe("");
					expect(inspect("source", "-ICC_Profile", "-b")).toEqual(icc);
					expect(inspect("cleaned", "-ICC_Profile", "-b")).toEqual(icc);
				},
			);
		},
	);

	test("returns fixed cancellation feedback", async () => {
		const jpeg = insert(await photo(400, 300), exif([[0x112, 6]]));
		const controller = new AbortController();
		const pending = cleanJpeg(jpeg, { signal: controller.signal });
		controller.abort(secret);
		await expect(pending).rejects.toMatchObject({ code: "cancelled" });
		await expect(cleanJpeg(jpeg, { signal: controller.signal })).rejects.toMatchObject({
			code: "cancelled",
		});
	});
});
