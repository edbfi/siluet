import { checkIccProfile } from "./icc-profile";
import { refuseJpeg } from "./jpeg-errors";

const iccLimit = 1024 * 1024;
export function readJpegIcc(parts: Buffer[], grayscale: boolean) {
	if (!parts.length) return;
	const total = parts.length;
	const sorted = parts.toSorted((a, b) => a[12] - b[12]);
	let size = 0;
	for (const [index, part] of sorted.entries()) {
		if (part.length <= 14 || part[12] !== index + 1 || part[13] !== total) refuseJpeg("color");
		size += part.length - 14;
	}
	if (size > iccLimit) refuseJpeg("limit");
	const profile = Buffer.concat(
		sorted.map((part) => part.subarray(14)),
		size,
	);
	if (profile.length >= 132 && profile.readUInt32BE(128) > 1024) refuseJpeg("color");
	return checkIccProfile(profile, grayscale, refuseJpeg);
}
