import { afterFileType, c2paBox, h264Aac } from "./mp4-boxes";

// Synthetic clips laid out like the H3 Max (Poyo.ai) and Seedance (ToAPIs) results inspected
// on 2026-11-24. The samples are h264Aac's; the C2PA stores are zero-filled stand-ins.

/** H3 Max: ftyp, a 13,353-byte C2PA box, moov, free, mdat. */
export const h3MaxShape = () => afterFileType(h264Aac(), c2paBox(13_353));
