// Synthetic files for original-mode verification. Test-only.
import { crc32, deflateSync } from "node:zlib";
import sharp from "sharp";

export const pngSignature = Buffer.from("89504e470d0a1a0a", "hex");

export function chunk(type: string, data = Buffer.alloc(0)) {
	const result = Buffer.alloc(data.length + 12);
	result.writeUInt32BE(data.length);
	result.write(type, 4, "ascii");
	result.set(data, 8);
	result.writeUInt32BE(crc32(result.subarray(4, -4)), result.length - 4);
	return result;
}

export function ihdr(width = 2, height = 2) {
	const data = Buffer.alloc(13);
	data.writeUInt32BE(width);
	data.writeUInt32BE(height, 4);
	data.set([8, 2, 0, 0, 0], 8);
	return chunk("IHDR", data);
}

/** A complete 2×2 RGB PNG with `extra` chunks before its image data. */
export function png(...extra: Buffer[]) {
	const rows = Buffer.from([0, 1, 2, 3, 4, 5, 6, 0, 7, 8, 9, 10, 11, 12]);
	return Buffer.concat([
		pngSignature,
		ihdr(),
		...extra,
		chunk("IDAT", deflateSync(rows)),
		chunk("IEND"),
	]);
}

export function iccp(profile: Buffer, method = 0, keyword = "device profile") {
	return chunk(
		"iCCP",
		Buffer.concat([Buffer.from(`${keyword}\0`), Buffer.from([method]), deflateSync(profile)]),
	);
}

/** A minimal ICC header and tag table. Only the tags matter to the HDR test. */
export function icc(tags: [signature: string, element: Buffer][], space = "RGB ") {
	const table = 132 + tags.length * 12;
	const elements: Buffer[] = [];
	const entries = Buffer.alloc(tags.length * 12);
	let offset = table;
	for (const [index, [signature, element]] of tags.entries()) {
		entries.write(signature, index * 12, "latin1");
		entries.writeUInt32BE(offset, index * 12 + 4);
		entries.writeUInt32BE(element.length, index * 12 + 8);
		const padded = Buffer.alloc(Math.ceil(element.length / 4) * 4);
		element.copy(padded);
		elements.push(padded);
		offset += padded.length;
	}
	const header = Buffer.alloc(132);
	header.writeUInt32BE(offset);
	header[8] = 4;
	header.write("mntr", 12, "latin1");
	header.write(space, 16, "latin1");
	header.write("XYZ ", 20, "latin1");
	header.write("acsp", 36, "latin1");
	header.writeUInt32BE(tags.length, 128);
	return Buffer.concat([header, entries, ...elements]);
}

export const cicpTag = (primaries: number, transfer: number) =>
	["cicp", Buffer.from([...Buffer.from("cicp"), 0, 0, 0, 0, primaries, transfer, 0, 1])] as [
		string,
		Buffer,
	];
export const gainTag = ["ADGC", Buffer.from("adgc\0\0\0\0\0\0\0\0")] as [string, Buffer];
export const hagcType = ["test", Buffer.from("hagc\0\0\0\0\0\0\0\0")] as [string, Buffer];
export const lutTag = ["A2B0", Buffer.from("mAB \0\0\0\0\x03\x03\0\0")] as [string, Buffer];

export const segment = (code: number, data: Buffer) => {
	const header = Buffer.from([0xff, code, 0, 0]);
	header.writeUInt16BE(data.length + 2, 2);
	return Buffer.concat([header, data]);
};

/** Insert segments after a JPEG's SOI. */
export const withSegments = (jpeg: Buffer, ...segments: Buffer[]) =>
	Buffer.concat([jpeg.subarray(0, 2), ...segments, jpeg.subarray(2)]);

export const iccSegments = (profile: Buffer, size = 65_519) => {
	const parts = [];
	for (let offset = 0; offset < profile.length; offset += size)
		parts.push(profile.subarray(offset, offset + size));
	return parts.map((part, index) =>
		segment(
			0xe2,
			Buffer.concat([Buffer.from("ICC_PROFILE\0"), Buffer.from([index + 1, parts.length]), part]),
		),
	);
};

export async function jpeg(options: { orientation?: number; cmyk?: boolean; width?: number } = {}) {
	let image = sharp({
		create: { width: options.width ?? 16, height: 8, channels: 3, background: "#4080c0" },
	});
	if (options.cmyk) image = image.toColourspace("cmyk");
	if (options.orientation) image = image.withMetadata({ orientation: options.orientation });
	return image.jpeg({ quality: 90 }).toBuffer();
}

/**
 * A flat 8-bit grayscale baseline JPEG of `mcus` 8×8 blocks in one row, coded with
 * one-symbol Huffman tables and a restart marker after every block.
 */
export function restartJpeg(columns: number, rows: number) {
	const quantization = segment(0xdb, Buffer.concat([Buffer.from([0]), Buffer.alloc(64, 1)]));
	const frame = Buffer.alloc(9);
	frame[0] = 8;
	frame.writeUInt16BE(rows * 8, 1);
	frame.writeUInt16BE(columns * 8, 3);
	frame.set([1, 1, 0x11, 0], 5);
	const table = (kind: number) => Buffer.from([kind, 1, ...Array.from({ length: 15 }, () => 0), 0]);
	const huffman = segment(0xc4, Buffer.concat([table(0x00), table(0x10)]));
	const restart = segment(0xdd, Buffer.from([0, 1]));
	const scan = segment(0xda, Buffer.from([1, 1, 0x00, 0, 63, 0]));
	const blocks = columns * rows;
	const data: number[] = [];
	for (let block = 0; block < blocks; block++) {
		// DC difference 0 and EOB are both the one-bit code 0; pad the byte with ones.
		data.push(0x3f);
		if (block < blocks - 1) data.push(0xff, 0xd0 + (block % 8));
	}
	return Buffer.concat([
		Buffer.from([0xff, 0xd8]),
		quantization,
		segment(0xc0, frame),
		huffman,
		restart,
		scan,
		Buffer.from(data),
		Buffer.from([0xff, 0xd9]),
	]);
}
