import { crc32 } from "node:zlib";
import sharp from "sharp";

function segment(marker: number, payload: Buffer) {
	const header = Buffer.from([0xff, marker, 0, 0]);
	header.writeUInt16BE(payload.length + 2, 2);
	return Buffer.concat([header, payload]);
}

function insert(jpeg: Buffer, ...markers: Buffer[]) {
	return Buffer.concat([jpeg.subarray(0, 2), ...markers, jpeg.subarray(2)]);
}

/** A little-endian EXIF block with only an orientation tag. */
export function exifOrientation(orientation: number) {
	const ifd = Buffer.alloc(18);
	ifd.writeUInt16LE(1);
	ifd.writeUInt16LE(0x112, 2);
	ifd.writeUInt16LE(3, 4);
	ifd.writeUInt32LE(1, 6);
	ifd.writeUInt16LE(orientation, 10);
	const tiff = Buffer.concat([Buffer.from([73, 73, 42, 0, 8, 0, 0, 0]), ifd]);
	return segment(0xe1, Buffer.concat([Buffer.from("Exif\0\0"), tiff]));
}

function picture(width: number, height: number) {
	const data = Buffer.alloc(width * height * 3);
	for (let y = 0; y < height; y++)
		for (let x = 0; x < width; x++)
			data.set(
				x < width / 3 && y < height / 4
					? [230, 40, 40]
					: [(x * 255) / width, (y * 255) / height, 90],
				(y * width + x) * 3,
			);
	return sharp(data, { raw: { width, height, channels: 3 } });
}

export const localImageMarker = "private-local-image-comment";

/** A 48×32 JPEG stored sideways (EXIF orientation 6) with a planted comment. */
export async function rotatedJpeg() {
	const jpeg = await picture(48, 32).jpeg({ quality: 90 }).toBuffer();
	return insert(jpeg, exifOrientation(6), segment(0xfe, Buffer.from(localImageMarker)));
}

export async function uprightPng() {
	return picture(30, 20).png().toBuffer();
}

export async function cmykJpeg() {
	return picture(24, 24).toColourspace("cmyk").jpeg().toBuffer();
}

export const localFilenameMarker = "private-local-filename";

/**
 * An upright JPEG or PNG carrying a planted comment, named with a private marker. The
 * cleaner removes the comment; an original keeps it.
 */
export async function markedFile(format: "jpeg" | "png") {
	const image = picture(40, 30);
	const name = `${localFilenameMarker}.${format === "png" ? "png" : "jpg"}`;
	if (format === "jpeg") {
		const jpeg = await image.jpeg({ quality: 90 }).toBuffer();
		return {
			name,
			mimeType: "image/jpeg",
			buffer: insert(jpeg, segment(0xfe, Buffer.from(localImageMarker))),
		};
	}
	const png = await image.png().toBuffer();
	// A tEXt chunk after IHDR (8-byte signature + 25-byte IHDR chunk).
	const text = Buffer.concat([Buffer.from("Comment\0"), Buffer.from(localImageMarker)]);
	const chunk = Buffer.alloc(text.length + 12);
	chunk.writeUInt32BE(text.length);
	chunk.write("tEXt", 4, "ascii");
	text.copy(chunk, 8);
	chunk.writeUInt32BE(crc32(chunk.subarray(4, -4)), chunk.length - 4);
	return {
		name,
		mimeType: "image/png",
		buffer: Buffer.concat([png.subarray(0, 33), chunk, png.subarray(33)]),
	};
}
