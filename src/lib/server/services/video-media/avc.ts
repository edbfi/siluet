import { bitReader } from "./bits";
import { check } from "./errors";
import { fields } from "./mp4-boxes";

// H.264 decoder configuration (ISO/IEC 14496-15 avcC, ITU-T H.264 §7.3.2.1.1).
// Siluet reads the declared configuration only; the browser validates samples.

const spsByteLimit = 1024;
const profiles = new Set([66, 77, 100]); // Baseline, Main, High
// Profiles whose SPS carries chroma format, bit depth and scaling matrices.
const extended = new Set([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135]);

/** Refuse an HDR or unknown transfer characteristic (ITU-T H.273), from `colr` or the SPS VUI. */
export function checkTransfer(transfer: number) {
	check([1, 2, 4, 5, 6, 13].includes(transfer), "HDR or unknown transfer");
}

/** Remove emulation-prevention bytes (0x000003) from a NAL unit payload. */
function rbsp(nal: Buffer) {
	const out: number[] = [];
	let zeros = 0;
	for (const byte of nal) {
		if (zeros >= 2 && byte === 3) {
			zeros = 0;
			continue;
		}
		zeros = byte === 0 ? zeros + 1 : 0;
		out.push(byte);
	}
	return Uint8Array.from(out);
}

function skipScalingList(read: ReturnType<typeof bitReader>, size: number) {
	let last = 8;
	let next = 8;
	for (let j = 0; j < size; j++) {
		if (next !== 0) next = (last + read.se() + 256) % 256;
		if (next !== 0) last = next;
	}
}

/** The cropped picture size of one SPS NAL unit, refusing anything outside the profile. */
export function readSps(nal: Buffer) {
	check(nal.length >= 4 && nal.length <= spsByteLimit, "SPS size");
	check((nal[0] & 0x9f) === 7, "SPS NAL header");
	const read = bitReader(rbsp(nal.subarray(1)), "SPS");
	const profile = read.bits(8);
	read.bits(16); // constraint flags, reserved bits and level
	check(profiles.has(profile), `H.264 profile ${profile}`);
	check(read.ue() <= 31, "SPS id");
	let chroma = 1;
	if (extended.has(profile)) {
		chroma = read.ue();
		check(chroma === 1, "chroma format other than 4:2:0");
		check(read.ue() === 0 && read.ue() === 0, "bit depth other than 8");
		read.bit(); // qpprime_y_zero_transform_bypass_flag
		const matrix = read.bit();
		for (let i = 0; matrix && i < 8; i++) {
			const present = read.bit();
			if (present) skipScalingList(read, i < 6 ? 16 : 64);
		}
	}
	check(read.ue() <= 12, "frame number size");
	const order = read.ue();
	check(order <= 2, "picture order count type");
	if (order === 0) check(read.ue() <= 12, "picture order count size");
	if (order === 1) {
		read.bit();
		read.se();
		read.se();
		const cycle = read.ue();
		check(cycle <= 255, "picture order count cycle");
		for (let i = 0; i < cycle; i++) read.se();
	}
	read.ue(); // max_num_ref_frames
	read.bit(); // gaps_in_frame_num_value_allowed_flag
	const widthMbs = read.ue() + 1;
	const heightUnits = read.ue() + 1;
	const frames = read.bit();
	if (!frames) read.bit(); // mb_adaptive_frame_field_flag
	read.bit(); // direct_8x8_inference_flag
	let [left, right, top, bottom] = [0, 0, 0, 0];
	if (read.bit()) [left, right, top, bottom] = [read.ue(), read.ue(), read.ue(), read.ue()];
	// 4:2:0 crops in units of two luma samples, doubled vertically for field coding.
	const width = widthMbs * 16 - 2 * (left + right);
	const height = (2 - frames) * heightUnits * 16 - 2 * (2 - frames) * (top + bottom);
	check(width > 0 && height > 0, "cropped picture size");
	// VUI up to the colour description (H.264 §E.1.1).
	if (read.bit()) {
		if (read.bit() && read.bits(8) === 255) read.bits(32); // aspect_ratio_idc, SAR
		if (read.bit()) read.bit(); // overscan_appropriate_flag
		if (read.bit()) {
			read.bits(4); // video_format, video_full_range_flag
			if (read.bit()) {
				read.bits(8); // colour_primaries
				checkTransfer(read.bits(8));
				read.bits(8); // matrix_coefficients
			}
		}
	}
	return { profile, width, height };
}

/** Check every SPS in an avcC record and require at least one SPS and one PPS. */
export function checkAvcConfig(avcC: Buffer, width: number, height: number) {
	const read = fields(avcC);
	check(read.u8(0) === 1, "avcC version");
	check((read.u8(4) & 3) !== 2, "NAL length size");
	let at = 6;
	const sets = (count: number, type: number) => {
		const units: Buffer[] = [];
		for (let i = 0; i < count; i++) {
			const length = read.u16(at);
			const unit = read.bytes(at + 2, length);
			check(length > 0 && (unit[0] & 0x1f) === type, "parameter set NAL type");
			units.push(unit);
			at += 2 + length;
		}
		return units;
	};
	const sps = sets(read.u8(5) & 0x1f, 7);
	const pps = sets(read.u8(at++), 8);
	check(sps.length > 0 && pps.length > 0, "missing SPS or PPS");
	for (const unit of sps) {
		const facts = readSps(unit);
		check(facts.width === width && facts.height === height, "SPS size differs from the track");
	}
}
