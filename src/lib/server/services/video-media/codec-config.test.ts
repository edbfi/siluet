import { expect, test } from "bun:test";
import { checkAacConfig } from "./aac";
import { checkAvcConfig, readSps } from "./avc";
import { UnsupportedVideoError } from "./errors";

// Copied from tests/fixtures/video/h264-aac.mp4: High profile 96×64 and AAC-LC 48 kHz mono.
const fixtureAvcC = Buffer.from(
	"0164000affe100186764000aacd94626c044000003000400000300603c48965801000668ebe3cb22c0fdf8f800",
	"hex",
);
const fixtureEsds = Buffer.from(
	"0000000003808080250002000480808017401500000000011131000111310580808005118856e500068080800102",
	"hex",
);

type Sps = {
	profile?: number;
	chroma?: number;
	depth?: number;
	scaling?: boolean;
	width: number;
	height: number;
	crop?: [number, number, number, number];
	/** VUI with a 255 aspect ratio, overscan and signal type, and a colour description when `transfer` is set. */
	vui?: { transfer?: number };
};
function bitWriter() {
	const bits: number[] = [];
	const put = (value: number, count: number) => {
		for (let i = count - 1; i >= 0; i--) bits.push(Math.floor(value / 2 ** i) % 2);
	};
	const ue = (value: number) => {
		const code = value + 1;
		const length = Math.floor(Math.log2(code));
		put(0, length);
		put(code, length + 1);
	};
	return {
		put,
		ue,
		se: (value: number) => ue(value > 0 ? 2 * value - 1 : -2 * value),
		bytes() {
			bits.push(1);
			while (bits.length % 8) bits.push(0);
			const out: number[] = [];
			for (let i = 0; i < bits.length; i += 8)
				out.push(Number.parseInt(bits.slice(i, i + 8).join(""), 2));
			return out;
		},
	};
}
/** A minimal SPS NAL unit, with emulation prevention applied. */
function sps({ profile = 100, chroma = 1, depth = 8, scaling, width, height, crop, vui }: Sps) {
	const w = bitWriter();
	w.put(profile, 8);
	w.put(0, 8);
	w.put(40, 8);
	w.ue(0);
	if (profile >= 100) {
		w.ue(chroma);
		if (chroma === 3) w.put(0, 1);
		w.ue(depth - 8);
		w.ue(depth - 8);
		w.put(0, 1);
		w.put(scaling ? 1 : 0, 1);
		if (scaling)
			for (let i = 0; i < 8; i++) {
				w.put(1, 1);
				for (let j = 0; j < (i < 6 ? 16 : 64); j++) w.se(j === 0 ? 8 : 0);
			}
	}
	w.ue(0);
	w.ue(2);
	w.ue(1);
	w.put(0, 1);
	w.ue(Math.ceil(width / 16) - 1);
	w.ue(Math.ceil(height / 16) - 1);
	w.put(1, 1);
	w.put(1, 1);
	w.put(crop ? 1 : 0, 1);
	for (const value of crop ?? []) w.ue(value);
	w.put(vui ? 1 : 0, 1);
	if (vui) {
		w.put(1, 1);
		w.put(255, 8);
		w.put(1, 16);
		w.put(1, 16);
		w.put(1, 1);
		w.put(0, 1);
		w.put(1, 1);
		w.put(5, 3);
		w.put(0, 1);
		w.put(vui.transfer === undefined ? 0 : 1, 1);
		if (vui.transfer !== undefined) {
			w.put(9, 8);
			w.put(vui.transfer, 8);
			w.put(9, 8);
		}
		w.put(0, 6); // no chroma location, timing, NAL or VCL HRD, picture structure or bitstream restriction
	}
	const raw = w.bytes();
	const escaped: number[] = [0x67];
	let zeros = 0;
	for (const byte of raw) {
		if (zeros >= 2 && byte <= 3) {
			escaped.push(3);
			zeros = 0;
		}
		escaped.push(byte);
		zeros = byte === 0 ? zeros + 1 : 0;
	}
	return Buffer.from(escaped);
}
const pps = Buffer.from([0x68, 0xeb, 0xe3, 0xcb, 0x22, 0xc0]);
function avcC(spsUnits: Buffer[], ppsUnits: Buffer[] = [pps]) {
	const unit = (nal: Buffer) => [nal.length >> 8, nal.length & 0xff, ...nal];
	return Buffer.from([
		1,
		100,
		0,
		40,
		0xff,
		0xe0 | spsUnits.length,
		...spsUnits.flatMap(unit),
		ppsUnits.length,
		...ppsUnits.flatMap(unit),
	]);
}
function esds({ oti = 0x40, asc = [0x11, 0x90] }: { oti?: number; asc?: number[] }) {
	const decoder = [oti, 0x15, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x05, asc.length, ...asc];
	const es = [0, 1, 0, 0x04, decoder.length, ...decoder];
	return Buffer.from([0, 0, 0, 0, 0x03, es.length, ...es]);
}
/** AudioSpecificConfig bits: object type, rate index (with optional explicit rate), channels. */
function asc(type: number, index: number, channels: number, explicit = 0) {
	const w = bitWriter();
	w.put(type, 5);
	w.put(index, 4);
	if (index === 15) w.put(explicit, 24);
	w.put(channels, 4);
	return w.bytes().slice(0, index === 15 ? 5 : 2);
}
const refuses = (work: () => unknown) => expect(work).toThrow(UnsupportedVideoError);

test("the fixture declares 8-bit 4:2:0 High profile video and AAC-LC 48 kHz mono", () => {
	expect(() => checkAvcConfig(fixtureAvcC, 96, 64)).not.toThrow();
	expect(checkAacConfig(fixtureEsds)).toEqual({ sampleRate: 48000, channels: 1 });
	expect(checkAacConfig(esds({ asc: asc(2, 3, 2) }))).toEqual({ sampleRate: 48000, channels: 2 });
});

test("SPS reading crops 1080p, skips scaling lists and survives emulation prevention", () => {
	const full = sps({ width: 1920, height: 1088, crop: [0, 0, 0, 4] });
	expect(readSps(full)).toMatchObject({ width: 1920, height: 1080 });
	expect(readSps(sps({ width: 1280, height: 720, scaling: true }))).toMatchObject({
		width: 1280,
		height: 720,
	});
	expect(readSps(sps({ profile: 66, width: 640, height: 352 }))).toMatchObject({ profile: 66 });
	expect(() => checkAvcConfig(avcC([full]), 1920, 1080)).not.toThrow();
});

test("each SPS must be Baseline, Main or High, 4:2:0, 8-bit and match the sample entry", () => {
	refuses(() =>
		checkAvcConfig(avcC([sps({ profile: 244, chroma: 3, width: 64, height: 64 })]), 64, 64),
	);
	refuses(() => checkAvcConfig(avcC([sps({ chroma: 3, width: 64, height: 64 })]), 64, 64));
	refuses(() =>
		checkAvcConfig(avcC([sps({ profile: 110, depth: 10, width: 64, height: 64 })]), 64, 64),
	);
	refuses(() => checkAvcConfig(avcC([sps({ depth: 10, width: 64, height: 64 })]), 64, 64));
	refuses(() =>
		checkAvcConfig(avcC([sps({ width: 2520, height: 1080, crop: [0, 0, 0, 0] })]), 1920, 1080),
	);
	refuses(() =>
		checkAvcConfig(
			avcC([sps({ width: 64, height: 64 }), sps({ depth: 10, width: 64, height: 64 })]),
			64,
			64,
		),
	);
	refuses(() => checkAvcConfig(avcC([sps({ width: 64, height: 64 })], []), 64, 64));
	refuses(() => checkAvcConfig(avcC([]), 64, 64));
	refuses(() => readSps(Buffer.concat([Buffer.from([0x67]), Buffer.alloc(1100, 0xff)])));
	refuses(() => checkAvcConfig(fixtureAvcC.subarray(0, 20), 96, 64));
});

test("an SPS colour description refuses what colr refuses", () => {
	const config = (vui: Sps["vui"]) => avcC([sps({ width: 64, height: 64, vui })]);
	expect(() => checkAvcConfig(config({}), 64, 64)).not.toThrow();
	expect(() => checkAvcConfig(config({ transfer: 1 }), 64, 64)).not.toThrow();
	for (const transfer of [16, 18]) refuses(() => checkAvcConfig(config({ transfer }), 64, 64));
});

test("esds must declare AAC-LC at a sample rate up to 48 kHz with one or two channels", () => {
	refuses(() => checkAacConfig(esds({ oti: 0x6b })));
	refuses(() => checkAacConfig(esds({ asc: asc(5, 3, 2) })));
	refuses(() => checkAacConfig(esds({ asc: asc(2, 15, 2, 0) })));
	refuses(() => checkAacConfig(esds({ asc: asc(2, 0, 2) })));
	refuses(() => checkAacConfig(esds({ asc: asc(2, 3, 6) })));
	refuses(() => checkAacConfig(fixtureEsds.subarray(0, 20)));
});
