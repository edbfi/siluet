import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	afterFileType,
	box,
	c2paBox,
	h264Aac,
	moveMovieAfterMedia,
	setField,
	topLevelBox,
} from "./mp4-boxes";

// Synthetic clips laid out like the H3 Max (Poyo.ai) and Seedance (ToAPIs) results inspected
// on 2026-11-24. The samples are h264Aac's; the C2PA stores are zero-filled stand-ins.

/** H3 Max: ftyp, a 13,353-byte C2PA box, moov, free, mdat. */
export const h3MaxShape = () => afterFileType(h264Aac(), c2paBox(13_353));

/**
 * Seedance: ftyp, a 21,456-byte C2PA box, free, mdat, moov. Its muxer leaves the one AAC
 * access unit of priming out of the audio mdhd: 97,024 − 1,024 at 48 kHz.
 */
export const seedanceShape = () =>
	setField(
		afterFileType(moveMovieAfterMedia(h264Aac()), c2paBox(21_456)),
		"moov/trak#1/mdia/mdhd",
		16,
		96_000,
	);

/**
 * The two inspected clips' structure: the `moov` bytes as recorded (in `real-clips/`; every
 * creation and modification time is 0, and the only strings are muxer and handler names) in
 * the recorded top-level order and sizes. Both files' `ftyp` equals h264Aac's. The C2PA box
 * is a synthetic stand-in and the `mdat` holds zeros, so the recorded chunk offsets still
 * land inside media data. No manifest, sample or identifier is kept.
 */
export function recordedClip(name: "h3-max" | "seedance") {
	const moov = readFileSync(join(import.meta.dir, "real-clips", `${name}.moov`));
	const ftyp = topLevelBox(h264Aac(), "ftyp");
	const free = box("free");
	if (name === "h3-max")
		return Buffer.concat([ftyp, c2paBox(13_353), moov, free, box("mdat", Buffer.alloc(1_875_001))]);
	return Buffer.concat([ftyp, c2paBox(21_456), free, box("mdat", Buffer.alloc(2_052_976)), moov]);
}
