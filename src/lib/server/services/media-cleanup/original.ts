import sharp from "sharp";
import { profileHdr } from "./icc-profile";
import { JpegCleanupError } from "./jpeg-errors";
import { jpegMaxPixels } from "./jpeg-markers";
import { verifyOriginalJpeg } from "./original-jpeg";
import { verifyOriginalPng } from "./original-png";
import { maxPngPixels } from "./png-chunks";
import { PngCleanupError } from "./png-errors";
import { mediaMime } from "./preparation-bytes";

export type VerifiedOriginal = { bytes: Uint8Array; transform: "original"; rotated: boolean };

/**
 * Verify a file the owner chose to send unchanged (D10) and return its own bytes.
 * After the structure check, one bounded full decode with ICC ignored must finish
 * with no warning at the declared size. The result records only whether the file
 * declares a rotation.
 */
export async function verifyOriginal(
	bytes: Uint8Array,
	{ signal, decoder = sharp }: { signal: AbortSignal; decoder?: typeof sharp },
): Promise<VerifiedOriginal> {
	const source = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const mime = mediaMime(source);
	const png = mime === "image/png";
	const fail = (code: "invalid" | "cancelled" | "hdr"): never => {
		if (png)
			throw new PngCleanupError(
				code === "invalid" ? "invalid-png" : code === "hdr" ? "hdr-png" : "cancelled",
			);
		throw new JpegCleanupError(code);
	};
	const active = () => {
		if (signal.aborted) fail("cancelled");
	};
	active();
	if (!mime) return fail("invalid");
	const header = png ? await verifyOriginalPng(source, signal) : verifyOriginalJpeg(source);
	active();
	let warned = false;
	try {
		// https://sharp.pixelplumbing.com/api-constructor/
		const image = decoder(source, {
			limitInputPixels: png ? maxPngPixels : jpegMaxPixels,
			failOn: "warning",
			ignoreIcc: true,
			sequentialRead: true,
		});
		// libpng reports a profile it cannot use and then ignores it, as ignoreIcc does
		// anyway. The structure walk already refused a second profile; other profile
		// content is metadata the owner chose to send.
		image.on("warning", (message: string) => {
			if (!(png && /^iCCP: /.test(message))) warned = true;
		});
		const { format, width, height, orientation, icc } = await image.metadata();
		active();
		if (warned || format !== (png ? "png" : "jpeg")) fail("invalid");
		// The decoder may assemble a profile the structure walk did not, for example
		// when a later ICC marker leaves the walk's set incomplete. The walk already
		// bounded every ICC byte to 1 MiB.
		if (icc && profileHdr(icc) === "hdr") fail("hdr");
		if (width !== header.width || height !== header.height) fail("invalid");
		const { info } = await image
			.timeout({ seconds: 5 })
			.raw()
			.toBuffer({ resolveWithObject: true });
		active();
		if (warned || info.width !== header.width || info.height !== header.height) fail("invalid");
		return {
			bytes,
			transform: "original",
			rotated: orientation !== undefined && orientation >= 2 && orientation <= 8,
		};
	} catch (error) {
		active();
		if (error instanceof JpegCleanupError || error instanceof PngCleanupError) throw error;
		return fail("invalid");
	}
}
