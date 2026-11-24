import { afterFileType, c2paBox, h264Aac, moveMovieAfterMedia, setField } from "./mp4-boxes";

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
