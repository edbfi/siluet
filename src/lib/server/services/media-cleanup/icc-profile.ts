import { createHash } from "node:crypto";
import { profileText } from "./icc-text";

// Use exact, published profiles as evidence of sRGB. Description and cICP
// labels alone cannot prove that the profile's transforms match sRGB.
// https://github.com/libvips/libvips/blob/v8.18.7/libvips/colour/profiles/sRGB.icm
// https://registry.color.org/rgb-registry/srgbprofiles
// The legacy HP profile's matrix and sampled TRC match IEC 61966-2-1.
// https://experienceleague.adobe.com/en/docs/dynamic-media-developer-resources/image-serving-api/image-serving-api/http-protocol-reference/syntax-and-features/r-color-management
// https://github.com/itsab1989/ChromIQ/blob/d4902a7d4e590a4e24d8980656fc97618a323743/assets/clipborder.psd
const srgbProfiles = new Set([
	"3f6d674174f3804eb0dabdac90ae17486e898c5063a66f861c116ea033da8301", // HP sRGB IEC61966-2.1
	"c56e1685d888f5edb92fe07f2750f387f8fe8e91b32ff8fb0b56bfbbb9458353", // libvips
	"384b832de3412066743b52a75ee906b6fb9fb8d9e09e936fc2c43223815c6e0a", // sRGB2014
	"83174717332326ddc198d9df188a4daec27b8979ba152cebbfc470c793d0bb11", // sRGB v4 Preference
	"f54b145a18e4b12112750e672f1c79cac9347dc8403da3955e7f74a352816a21", // v4 Preference display class
]);

// libvips v8.18.7's Display P3 matrix profile uses the compact description sP3C.
const displayP3Digest = "231752984cd4a5278e1b8d2390fe496767d4511fc81f54e1a5c69ae9ab4c42b5";

export type IccIdentity = { srgb: boolean; names: Set<string> };

// ITU-T H.273 tables 2 and 3.
const primaries = new Set([1, 4, 5, 6, 7, 8, 9, 10, 11, 12, 22]);
const sdrTransfers = new Set([1, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 17]);

type ColorProblem = "color" | "hdr";

export function cicpProblem(data: Buffer, inProfile = false): ColorProblem | undefined {
	if (data.length !== 4) return "color";
	const [primary, transfer, matrix, range] = data;
	if (transfer === 16 || transfer === 18) return "hdr";
	if (
		!(primaries.has(primary) || (inProfile && primary === 2)) ||
		!sdrTransfers.has(transfer) ||
		matrix !== 0 ||
		range > 1
	) {
		return "color";
	}
}

// ICC.1 sections 10.6 and 10.18 give the element sizes, and Annex F
// requires a nonconstant monotone curve for the inverse. Plateaus are allowed.
function isToneCurve(element: Buffer | undefined, version: number): boolean {
	if (!element || element.length < 12 || element.readUInt32BE(4) !== 0) return false;
	const type = element.toString("latin1", 0, 4);
	if (type === "curv") return isSampledCurve(element);
	if (version !== 4 || type !== "para" || element.readUInt16BE(10) !== 0) return false;
	return isParametricCurve(element);
}

function isSampledCurve(element: Buffer): boolean {
	const entries = element.readUInt32BE(8);
	if (element.length !== 12 + 2 * entries) return false;
	if (entries === 0) return true; // Identity.
	if (entries === 1) return element.readUInt16BE(12) > 0; // u8Fixed8 gamma.
	let previous = element.readUInt16BE(12);
	const direction = Math.sign(element.readUInt16BE(element.length - 2) - previous);
	if (direction === 0) return false;
	for (let offset = 14; offset < element.length; offset += 2) {
		const value = element.readUInt16BE(offset);
		if ((value - previous) * direction < 0) return false;
		previous = value;
	}
	return true;
}

function clip(value: number) {
	return Math.max(0, Math.min(1, value));
}

// Nominal transfer functions can have a small downward step when encoded in
// s15Fixed16. Preserve these exact parameter sets without relaxing other joins.
// Both occur in Elle Stone's Rec709-elle-V4-rec709 and sRGB-elle-V4-labl.
// https://github.com/ellelstone/elles_icc_profiles/tree/23c6ae3c733bec0a22573dfe36127864cf7226f2/profiles
const qualifiedJunctions = new Set([
	"000238e40000e8f000001710000038e4000014bc", // BT.709, rounded
	"000300000000dcb10000234f00001c570000147b", // L*, rounded
]);

function isParametricCurve(element: Buffer): boolean {
	const kind = element.readUInt16BE(8);
	const count = [1, 3, 4, 5, 7][kind];
	if (count === undefined || element.length !== 12 + 4 * count) return false;
	const [gamma, a, b, c = 0, d = 0, e = 0, f = 0] = Array.from(
		{ length: count },
		(_, index) => element.readInt32BE(12 + 4 * index) / 65536,
	);
	if (gamma <= 0) return false;
	if (kind === 0) return true;
	if (a <= 0) return false;

	// Table 68. Functions 1 and 2 use a constant branch below -b/a.
	const start = kind < 3 ? -b / a : d;
	const offset = kind === 2 ? c : e;
	const slope = kind < 3 ? 0 : c;
	const intercept = kind === 2 ? c : f;
	const linear = (x: number) => clip(slope * x + intercept);
	if (start > 1) return linear(0) !== linear(1);

	// At an implicit junction the base is exactly zero. Reconstructing
	// a * (-b/a) + b could produce a spurious negative from rounding.
	const base = kind < 3 && start > 0 ? 0 : a * Math.max(0, start) + b;
	if (base < 0) return false;
	const maxPower = (a + b) ** gamma;
	if (!Number.isFinite(maxPower)) return false;

	const upper = clip(maxPower + offset);
	const right = clip(base ** gamma + offset);
	if (start <= 0) return upper > right;

	// Both branches are individually monotone after clipping. The limits
	// on either side of their junction complete the monotonicity check.
	const lower = linear(0);
	const left = linear(start);
	const direction = Math.sign(upper - lower);
	if (direction > 0 && right < left && kind >= 3 && e === 0 && f === 0) {
		return qualifiedJunctions.has(element.toString("hex", 12, 32));
	}
	return (
		direction !== 0 &&
		(left - lower) * direction >= 0 &&
		(right - left) * direction >= 0 &&
		(upper - right) * direction >= 0
	);
}

function isXyz(element: Buffer | undefined): boolean {
	return (
		element?.length === 20 &&
		element.toString("latin1", 0, 4) === "XYZ " &&
		element.readUInt32BE(4) === 0
	);
}

// An element that declares HDR: an adaptive gain curve, or a cicp tag with a PQ or HLG transfer.
// https://media.color.org/icc1_amendment_headroom_adaptive_gain_curve.pdf
function tagHdr(profile: Buffer, tag: string, offset: number, size: number) {
	const type = profile.toString("latin1", offset, offset + 4);
	if (tag === "ADGC" || tag === "HAGC" || type === "adgc" || type === "hagc") return true;
	return (
		(tag === "cicp" || type === "cicp") &&
		size === 12 &&
		cicpProblem(profile.subarray(offset + 8, offset + 12), true) === "hdr"
	);
}

/**
 * Whether a profile declares HDR, for an original sent unchanged. It walks only a tag
 * table that fits the profile and never judges other color content: a profile it
 * cannot read, or one that is not sRGB, gives nothing.
 */
export function profileHdr(profile: Buffer): "hdr" | undefined {
	if (profile.length < 132) return;
	const count = profile.readUInt32BE(128);
	if (count > (profile.length - 132) / 12) return;
	for (let entry = 132; entry < 132 + count * 12; entry += 12) {
		const offset = profile.readUInt32BE(entry + 4);
		const size = profile.readUInt32BE(entry + 8);
		if (size < 4 || offset + size > profile.length) continue;
		if (tagHdr(profile, profile.toString("latin1", entry, entry + 4), offset, size)) return "hdr";
	}
}

// ICC.1 sections 7.2–8.4 and 9.2.17.
// https://www.color.org/specifications/ICC.1-2022-05.pdf
export function checkIccProfile(
	profile: Buffer,
	grayscale: boolean,
	refuse: (problem: ColorProblem) => never,
) {
	if (
		profile.length < 132 ||
		profile.readUInt32BE() !== profile.length ||
		(profile[8] !== 2 && profile[8] !== 4) ||
		profile.toString("latin1", 36, 40) !== "acsp" ||
		profile.toString("latin1", 16, 20) !== (grayscale ? "GRAY" : "RGB ")
	)
		refuse("color");

	const count = profile.readUInt32BE(128);
	const end = 132 + count * 12;
	if (count === 0 || end > profile.length) refuse("color");
	const tags = new Map<string, Buffer>();
	const ranges: { start: number; end: number }[] = [];
	for (let entry = 132; entry < end; entry += 12) {
		const tag = profile.toString("latin1", entry, entry + 4);
		const offset = profile.readUInt32BE(entry + 4);
		const size = profile.readUInt32BE(entry + 8);
		if (tags.has(tag) || offset < end || offset % 4 || size < 8 || offset + size > profile.length) {
			refuse("color");
		}
		tags.set(tag, profile.subarray(offset, offset + size));
		ranges.push({ start: offset, end: offset + size });

		const type = profile.toString("latin1", offset, offset + 4);
		if (tagHdr(profile, tag, offset, size)) refuse("hdr");
		if (tag === "cicp" || type === "cicp") {
			if (tag !== type || size !== 12) refuse("color");
			const problem = cicpProblem(profile.subarray(offset + 8, offset + 12), true);
			if (problem) refuse(problem);
		}
	}
	let start = end;
	let stop = end;
	for (const range of ranges.sort((left, right) => left.start - right.start)) {
		// Multiple tags may reference the same complete element.
		if (range.start === start && range.end === stop) continue;
		if (range.start < stop) refuse("color");
		start = range.start;
		stop = range.end;
	}

	// The exact sRGB reference profiles also include qualified Lab PCS lookup tables.
	const digest = createHash("sha256").update(profile).digest("hex");
	const version = profile[8];
	const names = profileText(tags.get("desc"), version === 4 ? "mluc" : "desc");
	if (!names) refuse("color");
	if (srgbProfiles.has(digest)) return { srgb: true, names };

	// Qualify matrix/TRC and monochrome input/display transforms. LUT-based
	// transforms have different required tags and can override the matrix.
	const device = profile.toString("latin1", 12, 16);
	if ((device !== "mntr" && device !== "scnr") || profile.toString("latin1", 20, 24) !== "XYZ ")
		refuse("color");
	const copyrightType = version === 4 ? "mluc" : "text";
	const white = tags.get("wtpt");
	if (!white || !isXyz(white) || [8, 12, 16].some((offset) => white.readInt32BE(offset) <= 0))
		refuse("color");
	if (version === 4 && device === "mntr" && white.toString("hex", 8) !== "0000f6d6000100000000d32d")
		refuse("color");
	if (!profileText(tags.get("cprt"), copyrightType)) refuse("color");
	for (const name of tags.keys()) {
		if (/^(A2B|B2A|D2B|B2D)[0-3]$/.test(name)) refuse("color");
	}
	if (grayscale) {
		if (!isToneCurve(tags.get("kTRC"), version)) refuse("color");
	} else {
		for (const channel of ["r", "g", "b"]) {
			if (!isXyz(tags.get(`${channel}XYZ`)) || !isToneCurve(tags.get(`${channel}TRC`), version))
				refuse("color");
		}
	}
	if (digest === displayP3Digest) names.add("Display P3");
	return { srgb: false, names };
}
