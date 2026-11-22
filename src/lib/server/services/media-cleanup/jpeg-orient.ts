import sharp, { type Sharp } from "sharp";
import { JpegCleanupError, refuseJpeg } from "./jpeg-errors";
import {
	type JpegFrame,
	jpegMaxPixels,
	orientedJpegMaxBytes,
	readJpeg,
	writeJpeg,
} from "./jpeg-markers";
import { inspectJpegMetadata, rotatedMarkers } from "./jpeg-metadata";

type Metadata = ReturnType<typeof inspectJpegMetadata>;
type Raw = { data: Buffer; width: number; height: number; channels: number };

// Qualified by the rotation fixtures in jpeg.test.ts. Correct transforms measured
// luma PSNR 42.5–57.9 dB, 99.9th-percentile luma error 2–6 and RGB PSNR 37.1–54.2 dB.
// A wrong turn or mirror measured at most 16.2 dB, at least 89 and at most 9.5 dB.
export const orientationBounds = { lumaPsnr: 40, lumaP999: 48, rgbPsnr: 32 } as const;
const maxSamples = 1_000_000;
const seconds = 5;

/** Re-encode the upright copy with the EXIF transform applied. Sharp writes no metadata. */
export function encodeOriented(upright: Buffer, frame: JpegFrame, orientation: number) {
	// EXIF orientation 2–8 as libvips operations. Flips run before the rotation.
	// https://sharp.pixelplumbing.com/api-operation/
	const operations: Record<number, (image: Sharp) => Sharp> = {
		2: (image) => image.flop(),
		3: (image) => image.rotate(180),
		4: (image) => image.flip(),
		5: (image) => image.flip().rotate(90),
		6: (image) => image.rotate(90),
		7: (image) => image.flop().rotate(90),
		8: (image) => image.rotate(270),
	};
	const operation = operations[orientation];
	if (!operation) refuseJpeg("orientation");
	const [luma, ...chroma] = frame.components;
	const subsampled =
		chroma.length === 2 &&
		luma.h === 2 &&
		luma.v === 2 &&
		chroma.every(({ h, v }) => h === 1 && v === 1);
	let image = operation(
		sharp(upright, { limitInputPixels: jpegMaxPixels, failOn: "warning", ignoreIcc: true }),
	);
	if (frame.components.length === 1) image = image.toColourspace("b-w");
	return image
		.jpeg({
			quality: 95,
			chromaSubsampling: subsampled ? "4:2:0" : "4:4:4",
			mozjpeg: false,
			progressive: false,
		})
		.timeout({ seconds })
		.toBuffer();
}

async function decodeRaw(bytes: Buffer, signal?: AbortSignal): Promise<Raw> {
	if (signal?.aborted) refuseJpeg("cancelled");
	const decoder = sharp(bytes, {
		limitInputPixels: jpegMaxPixels,
		failOn: "warning",
		ignoreIcc: true,
		sequentialRead: true,
	});
	let warned = false;
	decoder.on("warning", () => {
		warned = true;
	});
	const { data, info } = await decoder
		.timeout({ seconds })
		.raw()
		.toBuffer({ resolveWithObject: true });
	if (warned) throw new Error("Decoder warning.");
	if (signal?.aborted) refuseJpeg("cancelled");
	return { data, width: info.width, height: info.height, channels: info.channels };
}

// Output pixel (x, y) shows source pixel sourcePoint(...) for EXIF orientation o.
function sourcePoint(o: number, x: number, y: number, width: number, height: number) {
	switch (o) {
		case 2:
			return [width - 1 - x, y];
		case 3:
			return [width - 1 - x, height - 1 - y];
		case 4:
			return [x, height - 1 - y];
		case 5:
			return [y, x];
		case 6:
			return [y, height - 1 - x];
		case 7:
			return [width - 1 - y, height - 1 - x];
		case 8:
			return [width - 1 - y, x];
		default:
			return [x, y];
	}
}

function grid(width: number, height: number) {
	let step = Math.max(1, Math.floor(Math.sqrt((width * height) / maxSamples)));
	while (Math.ceil(width / step) * Math.ceil(height / step) > maxSamples) step++;
	const points: [number, number][] = [];
	for (let y = 0; y < height; y += step) for (let x = 0; x < width; x += step) points.push([x, y]);
	return points;
}

function luma(samples: Uint8Array, index: number, channels: number) {
	const at = index * channels;
	return channels === 1
		? samples[at]
		: 0.299 * samples[at] + 0.587 * samples[at + 1] + 0.114 * samples[at + 2];
}

const psnr = (squared: number, count: number) =>
	squared === 0 ? Number.POSITIVE_INFINITY : 10 * Math.log10((255 * 255 * count) / squared);

/** Compare sampled source and output pixels. Exported for threshold qualification. */
export function compareSamples(source: Uint8Array, output: Uint8Array, channels: number) {
	const count = source.length / channels;
	const histogram = new Uint32Array(256);
	let lumaSquared = 0;
	let rgbSquared = 0;
	for (let i = 0; i < count; i++) {
		const delta = luma(source, i, channels) - luma(output, i, channels);
		lumaSquared += delta * delta;
		histogram[Math.min(255, Math.round(Math.abs(delta)))]++;
	}
	for (let i = 0; i < source.length; i++) {
		const delta = source[i] - output[i];
		rgbSquared += delta * delta;
	}
	let lumaP999 = 0;
	for (let seen = 0, needed = Math.ceil(count * 0.999); lumaP999 < 255; lumaP999++) {
		seen += histogram[lumaP999];
		if (seen >= needed) break;
	}
	return {
		lumaPsnr: psnr(lumaSquared, count),
		lumaP999,
		rgbPsnr: psnr(rgbSquared, source.length),
	};
}

function sample(raw: Raw, points: readonly (readonly number[])[]) {
	const { data, width, channels } = raw;
	const samples = new Uint8Array(points.length * channels);
	for (const [index, [x, y]] of points.entries()) {
		const at = (y * width + x) * channels;
		samples.set(data.subarray(at, at + channels), index * channels);
	}
	return samples;
}

function sameMarkers(
	actual: ReturnType<typeof readJpeg>,
	expected: { code: number; data: Buffer }[],
) {
	return (
		!actual.trailer &&
		actual.markers.length === expected.length &&
		expected.every(
			(marker, index) =>
				actual.markers[index].code === marker.code &&
				actual.markers[index].data.equals(marker.data) &&
				!actual.markers[index].afterScan,
		)
	);
}

export type OrientOptions = { signal?: AbortSignal; encode?: typeof encodeOriented };

/**
 * Apply EXIF orientation 2–8 to an upright, metadata-stripped JPEG and verify the
 * final bytes against the ICC-ignored source decode. Returns the rewrapped copy.
 */
export async function orientJpeg(
	upright: Buffer,
	frame: JpegFrame,
	metadata: Metadata,
	{ signal, encode = encodeOriented }: OrientOptions = {},
) {
	const { orientation } = metadata;
	const swap = orientation >= 5;
	const width = swap ? frame.height : frame.width;
	const height = swap ? frame.width : frame.height;
	const points = grid(width, height);
	let reference: Uint8Array;
	let channels: number;
	try {
		// Read the source samples first so its raw buffer is dropped before encoding.
		const source = await decodeRaw(upright, signal);
		if (source.width !== frame.width || source.height !== frame.height) refuseJpeg("invalid");
		channels = source.channels;
		reference = sample(
			source,
			points.map(([x, y]) => sourcePoint(orientation, x, y, frame.width, frame.height)),
		);
	} catch (error) {
		if (error instanceof JpegCleanupError) throw error;
		return refuseJpeg("invalid");
	}
	try {
		const encoded = await encode(upright, frame, orientation);
		if (signal?.aborted) refuseJpeg("cancelled");
		const markers = rotatedMarkers(metadata, swap);
		const output = writeJpeg(readJpeg(encoded, { maxBytes: orientedJpegMaxBytes }).image, markers);
		const result = readJpeg(output, { maxBytes: orientedJpegMaxBytes });
		inspectJpegMetadata(result);
		if (
			!sameMarkers(result, markers) ||
			result.frame.width !== width ||
			result.frame.height !== height ||
			result.frame.components.length !== frame.components.length
		)
			refuseJpeg("verification");
		const decoded = await decodeRaw(output, signal);
		if (decoded.width !== width || decoded.height !== height || decoded.channels !== channels)
			refuseJpeg("verification");
		const score = compareSamples(reference, sample(decoded, points), channels);
		if (
			score.lumaPsnr < orientationBounds.lumaPsnr ||
			score.lumaP999 > orientationBounds.lumaP999 ||
			score.rgbPsnr < orientationBounds.rgbPsnr
		)
			refuseJpeg("verification");
		return output;
	} catch (error) {
		if (signal?.aborted) refuseJpeg("cancelled");
		if (error instanceof JpegCleanupError && ["limit", "cancelled"].includes(error.code))
			throw error;
		return refuseJpeg("verification");
	}
}
