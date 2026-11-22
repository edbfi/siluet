import sharp from "sharp";
import { refuseJpeg } from "./jpeg-errors";
import { type JpegFrame, jpegMaxBytes, jpegMaxPixels, readJpeg, writeJpeg } from "./jpeg-markers";
import { inspectJpegMetadata, renderMarkers } from "./jpeg-metadata";
import { type OrientOptions, orientJpeg } from "./jpeg-orient";

export { JpegCleanupError } from "./jpeg-errors";

export type JpegCleanupOptions = OrientOptions;
export type CleanedJpeg = { bytes: Buffer; transform: "none" | "reencoded-rotation" };

function assertActive(signal?: AbortSignal) {
	if (signal?.aborted) refuseJpeg("cancelled");
}

async function decode(bytes: Buffer, frame: JpegFrame, signal?: AbortSignal) {
	assertActive(signal);
	try {
		// Mirror Gallery's strict decoder settings and require every pixel.
		// https://sharp.pixelplumbing.com/api-constructor/
		const decoder = sharp(bytes, {
			limitInputPixels: jpegMaxPixels,
			failOn: "warning",
			sequentialRead: true,
		});
		let warned = false;
		decoder.on("warning", () => {
			warned = true;
		});
		const { info } = await decoder
			.timeout({ seconds: 5 })
			.raw()
			.toBuffer({ resolveWithObject: true });
		if (warned || info.width !== frame.width || info.height !== frame.height) refuseJpeg("invalid");
	} catch {
		refuseJpeg("invalid");
	}
	assertActive(signal);
}

function verifyMarkers(
	output: ReturnType<typeof readJpeg>,
	expected: ReturnType<typeof renderMarkers>,
) {
	if (output.trailer || output.markers.length !== expected.length) refuseJpeg("verification");
	for (const [index, marker] of expected.entries()) {
		const actual = output.markers[index];
		if (actual.code !== marker.code || !actual.data.equals(marker.data) || actual.afterScan) {
			refuseJpeg("verification");
		}
	}
}

/**
 * Prepare a verified local copy. An upright JPEG keeps its frame and entropy-coded
 * data byte for byte. Orientations 2–8 are re-encoded once. Failure rejects with a
 * fixed reason and advice.
 */
export async function cleanJpeg(
	bytes: Uint8Array,
	options: JpegCleanupOptions = {},
): Promise<CleanedJpeg> {
	const { signal } = options;
	assertActive(signal);
	if (bytes.byteLength > jpegMaxBytes) refuseJpeg("limit");
	// A view: the cleaner only reads its input.
	const source = readJpeg(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
	const metadata = inspectJpegMetadata(source);
	if (source.trailer) refuseJpeg("trailer");
	const upright = writeJpeg(source.image, renderMarkers(metadata));
	if (metadata.orientation !== 1) {
		const oriented = await orientJpeg(upright, source.frame, metadata, options);
		assertActive(signal);
		return { bytes: oriented, transform: "reencoded-rotation" };
	}
	await decode(upright, source.frame, signal);
	verifyMarkers(readJpeg(upright), renderMarkers(metadata));
	return { bytes: upright, transform: "none" };
}
