import { maxPngBytes, maxPngPixels, type PngHeader, parsePng, pngSignature } from "./png-chunks";
import { checkPngColor, neutralIccChunk } from "./png-color";
import { assertPngActive, PngCleanupError } from "./png-errors";
import { verifyImageData } from "./png-image-data";
import { checkPngExif, checkPngText, maxPngMetadataBytes } from "./png-metadata";

export { PngCleanupError } from "./png-errors";

async function verifyPngDecode(bytes: Buffer, header: PngHeader, signal?: AbortSignal) {
	const { default: sharp } = await import("sharp");
	assertPngActive(signal);
	// Force evaluation through the last scanline and fail closed on decoder warnings.
	// https://sharp.pixelplumbing.com/api-constructor/
	// https://sharp.pixelplumbing.com/api-output/#timeout
	const decoder = sharp(bytes, {
		failOn: "warning",
		limitInputPixels: maxPngPixels,
		ignoreIcc: true,
	});
	let warned = false;
	decoder.on("warning", () => {
		warned = true;
	});
	const { info } = await decoder
		.timeout({ seconds: 5 })
		.raw({ depth: header.depth === 16 ? "ushort" : "uchar" })
		.toBuffer({ resolveWithObject: true });
	if (warned || info.width !== header.width || info.height !== header.height) {
		throw new PngCleanupError("png-verification");
	}
}

export async function cleanPng(
	bytes: Uint8Array,
	{ signal }: { signal?: AbortSignal } = {},
): Promise<Uint8Array> {
	try {
		assertPngActive(signal);
		if (bytes.byteLength > maxPngBytes) throw new PngCleanupError("png-limit");
		// A view: the cleaner only reads its input.
		const source = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
		const { chunks, header, paletteSize } = parsePng(source);
		const retained: Buffer[] = [pngSignature];
		const idat: Buffer[] = [];
		let remainingMetadata = maxPngMetadataBytes;
		let primaryOrientation = false;
		function checkOrientation(found: boolean) {
			if (!found) return;
			if (primaryOrientation) throw new PngCleanupError("png-orientation");
			primaryOrientation = true;
		}
		for (const { type, data, encoded } of chunks) {
			assertPngActive(signal);
			switch (type) {
				case "caBX": // https://spec.c2pa.org/specifications/specifications/2.4/specs/C2PA_Specification.html#_embedding_manifests_into_png
				case "eXIf":
				case "hIST":
				case "sPLT":
				case "tIME":
					remainingMetadata -= data.length;
					if (remainingMetadata < 0) throw new PngCleanupError("png-limit");
					if (type === "eXIf") checkOrientation(checkPngExif(data));
					break;
				case "iTXt":
				case "zTXt":
				case "tEXt": {
					const text = await checkPngText(type, data, remainingMetadata, signal);
					remainingMetadata -= text.length;
					checkOrientation(text.primaryOrientation);
					break;
				}
				case "iCCP":
					retained.push(await neutralIccChunk(data, header.color));
					break;
				default:
					if (type === "IDAT") idat.push(data);
					checkPngColor(type, data, header);
					retained.push(encoded);
			}
		}

		await verifyImageData(idat, header, paletteSize, signal);
		const output = Buffer.concat(retained);
		if (output.length > maxPngBytes) throw new PngCleanupError("png-limit");
		await verifyPngDecode(output, header, signal);
		assertPngActive(signal);
		return output;
	} catch (error) {
		assertPngActive(signal);
		if (error instanceof PngCleanupError) throw error;
		throw new PngCleanupError("png-verification");
	}
}
