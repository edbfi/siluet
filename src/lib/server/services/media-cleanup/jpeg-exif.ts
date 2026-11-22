import { descriptiveStrings } from "./exif-fields";
import type { Density, Rational } from "./jpeg-density";
import { refuseJpeg } from "./jpeg-errors";
import type { JpegFrame } from "./jpeg-markers";

type Entry = { type: number; count: number; value: number };
type ExifMetadata = {
	orientation?: number;
	srgb: boolean;
	uncalibrated: boolean;
	density?: Density;
};

const sizes = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8];

// CIPA Exif IFD0 controls the primary image. Inspect Exif and Interoperability
// subdirectories for color declarations and discard IFD1 only as a thumbnail.
// https://www.cipa.jp/std/documents/e/DC-X008-Translation-2019-E.pdf
export function inspectExif(tiff: Buffer, { components }: JpegFrame): ExifMetadata {
	const order = tiff.toString("latin1", 0, 2);
	if (tiff.length < 8 || (order !== "II" && order !== "MM")) refuseJpeg("orientation");
	const little = order === "II";
	const u16 = (offset: number) => (little ? tiff.readUInt16LE(offset) : tiff.readUInt16BE(offset));
	const u32 = (offset: number) => (little ? tiff.readUInt32LE(offset) : tiff.readUInt32BE(offset));
	if (u16(2) !== 42) refuseJpeg("orientation");

	const visited = new Set<number>();
	function readDirectory(offset: number) {
		if (offset < 8 || offset + 2 > tiff.length || visited.has(offset)) refuseJpeg("orientation");
		visited.add(offset);
		const count = u16(offset);
		const end = offset + 2 + count * 12;
		if (count > 512 || end + 4 > tiff.length) refuseJpeg("orientation");
		const entries = new Map<number, Entry>();
		for (let i = offset + 2; i < end; i += 12) {
			const tag = u16(i);
			const type = u16(i + 2);
			const count = u32(i + 4);
			// Exif 3.0 type 129 represents a UTF-8 byte string.
			const fieldSize = type === 129 ? 1 : (sizes[type] ?? 0);
			const size = fieldSize * count;
			const value = size <= 4 ? i + 8 : u32(i + 8);
			const emptyDescription =
				count === 0 && descriptiveStrings.has(tag) && [2, 129].includes(type);
			if (
				entries.has(tag) ||
				(!size && !emptyDescription) ||
				value < 8 ||
				value + size > tiff.length
			) {
				refuseJpeg(tag === 0x0112 ? "orientation" : "metadata");
			}
			entries.set(tag, { type, count, value });
		}
		return { entries, next: u32(end) };
	}

	function scalar(
		entry: Entry,
		type: 3 | 4,
		code: "orientation" | "color" | "aspect" | "metadata",
	) {
		if (entry.type !== type || entry.count !== 1) refuseJpeg(code);
		return type === 3 ? u16(entry.value) : u32(entry.value);
	}
	function rational(entry: Entry): Rational {
		if (entry.type !== 5 || entry.count !== 1) refuseJpeg("aspect");
		const numerator = BigInt(u32(entry.value));
		const denominator = BigInt(u32(entry.value + 4));
		if (!numerator || !denominator) refuseJpeg("aspect");
		return [numerator, denominator];
	}
	function subdirectory(entries: Map<number, Entry>, tag: number) {
		const entry = entries.get(tag);
		if (!entry) return undefined;
		const directory = readDirectory(scalar(entry, 4, "metadata"));
		if (directory.entries.has(0x0112)) refuseJpeg("orientation");
		if (directory.next || directory.entries.has(0x014a)) refuseJpeg("secondary");
		return directory.entries;
	}

	const primary = readDirectory(u32(4));
	for (const tag of [0x0111, 0x0144, 0x014a, 0x0201, 0x0202]) {
		if (primary.entries.has(tag)) refuseJpeg("secondary");
	}
	if (primary.next) {
		const thumbnail = readDirectory(primary.next);
		const compression = thumbnail.entries.get(0x0103);
		if (
			thumbnail.next ||
			thumbnail.entries.has(0x014a) ||
			!compression ||
			![1, 6].includes(scalar(compression, 3, "metadata"))
		)
			refuseJpeg("secondary");
		// IFD1 describes a discarded thumbnail, including its own orientation.
		const tag = thumbnail.entries.get(0x0112);
		if (tag && ![1, 2, 3, 4, 5, 6, 7, 8].includes(scalar(tag, 3, "orientation"))) {
			refuseJpeg("orientation");
		}
	}

	const orientationTag = primary.entries.get(0x0112);
	const orientation = orientationTag && scalar(orientationTag, 3, "orientation");
	if (orientation !== undefined && (orientation < 1 || orientation > 8)) refuseJpeg("orientation");

	const exif = subdirectory(primary.entries, 0x8769);
	const interop = exif && subdirectory(exif, 0xa005);
	subdirectory(primary.entries, 0x8825);
	const colorTag = exif?.get(0xa001) ?? primary.entries.get(0xa001);
	const color = colorTag && scalar(colorTag, 3, "color");
	const index = interop?.get(1);
	if (
		(exif?.has(0xa001) && primary.entries.has(0xa001)) ||
		(color !== undefined && color !== 1 && color !== 0xffff) ||
		(index &&
			(index.type !== 2 ||
				index.count !== 4 ||
				tiff.toString("latin1", index.value, index.value + 4) !== "R98\0" ||
				color === 0xffff))
	) {
		refuseJpeg("color");
	}
	const srgb = color === 1 || index !== undefined;
	for (const tag of [0x012d, 0x013e, 0x013f, 0x0211, 0x0214, 0x8773, 0xa500]) {
		if (primary.entries.has(tag) || exif?.has(tag)) refuseJpeg("color");
	}
	for (const tag of [0x02bc, 0x8649]) {
		if (primary.entries.has(tag) || exif?.has(tag)) refuseJpeg("metadata");
	}
	if (exif?.has(0x0213)) refuseJpeg("color");
	const positioning = primary.entries.get(0x0213);
	if (positioning) {
		const value = scalar(positioning, 3, "color");
		const [{ h, v }] = components;
		// Chroma placement only affects the image when components are subsampled.
		if (value !== 1 && (value !== 2 || components.some((c) => c.h !== h || c.v !== v))) {
			refuseJpeg("color");
		}
	}

	const x = primary.entries.get(0x011a);
	const y = primary.entries.get(0x011b);
	const resolutionUnit = primary.entries.get(0x0128);
	const unit = resolutionUnit && scalar(resolutionUnit, 3, "aspect");
	if (unit !== undefined && ![1, 2, 3].includes(unit)) refuseJpeg("aspect");
	const metadata = { orientation, srgb, uncalibrated: color === 0xffff };
	if (!x && !y) return metadata;
	if (!x || !y) refuseJpeg("aspect");
	return { ...metadata, density: { x: rational(x), y: rational(y), unit } };
}
