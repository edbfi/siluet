import { isUtf8 } from "node:buffer";
import { descriptiveStrings } from "./exif-fields";
import { readKeywordEnd } from "./png-chunks";
import { assertPngActive, PngCleanupError } from "./png-errors";
import { inflatePng } from "./png-inflate";
import { checkPngXmp } from "./png-xmp";

export const maxPngMetadataBytes = 4 * 1024 * 1024;

const tiffFieldSizes = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8];
const exifIfdPointers = new Set([0x8769, 0x8825, 0xa005]);

export function checkPngExif(data: Buffer) {
	// eXIf directly contains an Exif TIFF profile. Check the directory graph and
	// relevant fields before dropping it, including the optional thumbnail IFD.
	// https://www.w3.org/TR/png-3/#eXIf
	const orientationError = () => new PngCleanupError("png-orientation");
	const byteOrder = data.toString("latin1", 0, 2);
	if (data.length < 8 || (byteOrder !== "II" && byteOrder !== "MM")) throw orientationError();
	const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
	const little = byteOrder === "II";
	const read16 = (offset: number) => view.getUint16(offset, little);
	const read32 = (offset: number) => view.getUint32(offset, little);
	if (read16(2) !== 42) throw orientationError();

	type Directory = { offset: number; role: "primary" | "thumbnail" | "metadata" };
	const pending: Directory[] = [{ offset: read32(4), role: "primary" }];
	const visited = new Set<number>();
	let primaryOrientation = false;
	let totalEntries = 0;
	while (pending.length > 0) {
		const directory = pending.pop();
		if (!directory) break;
		const { offset, role } = directory;
		let foundOrientation = false;
		if (offset < 8 || offset % 2 !== 0 || offset > data.length - 6 || visited.has(offset)) {
			throw orientationError();
		}
		visited.add(offset);

		const count = read16(offset);
		const entriesEnd = offset + 2 + count * 12;
		if (entriesEnd + 4 > data.length) throw orientationError();
		totalEntries += count;
		if (totalEntries > 4096) throw new PngCleanupError("png-limit");
		const next = read32(entriesEnd);
		if (next !== 0) {
			if (role !== "primary") throw orientationError();
			pending.push({ offset: next, role: "thumbnail" });
		}

		for (let entry = offset + 2; entry < entriesEnd; entry += 12) {
			const tag = read16(entry);
			const type = read16(entry + 2);
			const values = read32(entry + 4);
			// Exif 3.0 UTF-8 values (type 129) count encoded bytes.
			const size = (type === 129 ? 1 : tiffFieldSizes[type]) * values;
			if (!size && !(values === 0 && descriptiveStrings.has(tag) && (type === 2 || type === 129)))
				throw orientationError();
			if (size > 4) {
				const valueOffset = read32(entry + 8);
				if (valueOffset < 8 || valueOffset + size > data.length) throw orientationError();
			}
			if (tag === 0x0112) {
				const orientation = read16(entry + 8);
				if (
					foundOrientation ||
					type !== 3 ||
					values !== 1 ||
					role === "metadata" ||
					orientation < 1 ||
					orientation > (role === "thumbnail" ? 8 : 1)
				) {
					throw orientationError();
				}
				foundOrientation = true;
				if (role === "primary") primaryOrientation = true;
			}
			// SubIFDs are outside the Exif directory graph and can carry other images.
			if (tag === 0x014a) throw new PngCleanupError("unsupported-png-chunk");
			if (exifIfdPointers.has(tag)) {
				if (type !== 4 || values !== 1) throw orientationError();
				pending.push({ offset: read32(entry + 8), role: "metadata" });
			}
		}
	}
	return primaryOrientation;
}

export async function checkPngText(
	type: string,
	data: Buffer,
	remainingBytes: number,
	signal?: AbortSignal,
) {
	// https://www.w3.org/TR/png-3/#11textinfo
	const end = readKeywordEnd(data, "invalid-png");
	const keyword = data.toString("latin1", 0, end).toLowerCase();
	// Some writers embed raw profiles in text chunks. IPTC is descriptive.
	// Other legacy profiles can carry color or orientation and are ambiguous.
	if (keyword === "raw profile type exif" || keyword === "raw profile type app1") {
		throw new PngCleanupError("png-orientation");
	}
	if (keyword.startsWith("raw profile type ") && keyword !== "raw profile type iptc") {
		throw new PngCleanupError("unsupported-png-chunk");
	}

	let offset = end + 1;
	let compressed = type === "zTXt";
	let translatedKeyword: Buffer | undefined;
	if (type === "zTXt" && data[offset++] !== 0) throw new PngCleanupError("invalid-png");
	if (type === "iTXt") {
		const flag = data[offset++];
		if ((flag !== 0 && flag !== 1) || data[offset++] !== 0)
			throw new PngCleanupError("invalid-png");
		compressed = flag === 1;
		const languageEnd = data.indexOf(0, offset);
		const translatedEnd = languageEnd === -1 ? -1 : data.indexOf(0, languageEnd + 1);
		if (translatedEnd === -1) throw new PngCleanupError("invalid-png");
		translatedKeyword = data.subarray(languageEnd + 1, translatedEnd);
		offset = translatedEnd + 1;
	}
	const maxTextBytes = remainingBytes - offset;
	if (maxTextBytes < 0) throw new PngCleanupError("png-limit");
	if (translatedKeyword && !isUtf8(translatedKeyword)) throw new PngCleanupError("invalid-png");
	const text = compressed
		? await inflatePng(data.subarray(offset), maxTextBytes, {
				invalid: "invalid-png",
				oversized: "png-limit",
			})
		: data.subarray(offset);
	assertPngActive(signal);
	if (text.length > maxTextBytes) throw new PngCleanupError("png-limit");
	const isXmp = keyword === "xml:com.adobe.xmp";
	if (text.includes(0) || ((isXmp || translatedKeyword) && !isUtf8(text))) {
		throw new PngCleanupError("invalid-png");
	}
	const primaryOrientation = isXmp && checkPngXmp(text.toString("utf8"));
	return { length: offset + text.length, primaryOrientation };
}
