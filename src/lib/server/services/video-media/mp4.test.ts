import { expect, test } from "bun:test";
import {
	appendChild,
	box,
	h264Aac,
	locate,
	payload,
	replaceBox,
	rewrite,
	setField,
} from "../../../../../tests/fixtures/video/mp4-boxes";
import { UnsupportedVideoError } from "./errors";
import { inspectMovie } from "./mp4";

const video = "moov/trak#0";
const audio = "moov/trak#1";
const stbl = (track: string) => `${track}/mdia/minf/stbl`;

function inspect(bytes: Buffer) {
	const whole = (type: string) => {
		const node = locate(bytes, type)[0];
		return bytes.subarray(node.start, node.start + node.size);
	};
	const mdat = locate(bytes, "mdat")[0];
	return inspectMovie(whole("ftyp"), whole("moov"), [
		{ start: mdat.start + mdat.header, end: mdat.start + mdat.size },
	]);
}
const refused = (bytes: Buffer, reason: RegExp) => {
	expect(() => inspect(bytes)).toThrow(UnsupportedVideoError);
	expect(() => inspect(bytes)).toThrow(reason);
};
/** A version-0 table box payload with the given rows of 32-bit fields. */
const rows = (...entries: number[][]) => {
	const data = Buffer.alloc(8 + entries.length * entries[0].length * 4);
	data.writeUInt32BE(entries.length, 4);
	entries.flat().forEach((value, i) => {
		data.writeUInt32BE(value, 8 + i * 4);
	});
	return data;
};

test("the unchanged fixture passes with its edit lists, B-frame offsets and AAC priming", () => {
	const source = h264Aac();
	// Video stts = mdhd = 24,576 @ 12,288 with edit media_time 2,048; AAC stts = mdhd =
	// 97,024 @ 48 kHz with edit 1,024 + 96,000; mvhd 96,000 @ 48 kHz.
	expect(payload(source, `${video}/mdia/mdhd`).readUInt32BE(16)).toBe(24576);
	expect(payload(source, `${video}/edts/elst`).readInt32BE(12)).toBe(2048);
	expect(payload(source, `${audio}/mdia/mdhd`).readUInt32BE(16)).toBe(97024);
	expect(inspect(source)).toEqual({
		width: 96,
		height: 64,
		duration: 2,
		tracks: [
			{ type: "video", samples: 24 },
			{ type: "audio", samples: 95 },
		],
	});
});

test("mvhd must match the presented tracks, and the presentation stays within 12 seconds", () => {
	// 60 seconds of samples behind a 10-second mvhd.
	let long = setField(h264Aac(), `${video}/mdia/mdhd`, 16, 60 * 12288);
	long = rewrite(long, `${stbl(video)}/stts`, () => rows([24, (60 * 12288) / 24]));
	long = setField(long, "moov/mvhd", 16, 10 * 48000);
	refused(long, /mvhd duration/);
	refused(replaceBox(long, `${video}/edts`, null), /presented duration/);
	// Thirteen presented seconds with a matching mvhd.
	let over = setField(h264Aac(), `${video}/mdia/mdhd`, 16, 13 * 12288);
	over = rewrite(over, `${stbl(video)}/stts`, () => rows([24, (13 * 12288) / 24]));
	over = setField(over, `${video}/edts/elst`, 8, 13 * 48000);
	over = setField(over, "moov/mvhd", 16, 13 * 48000);
	refused(over, /presented duration/);
});

test("each track's stts must equal its mdhd duration and timescales must be positive", () => {
	refused(setField(h264Aac(), `${video}/mdia/mdhd`, 16, 24577), /stts duration differs/);
	refused(setField(h264Aac(), `${audio}/mdia/mdhd`, 12, 0), /mdhd timescale/);
	refused(setField(h264Aac(), "moov/mvhd", 12, 0), /mvhd timescale/);
});

test("edits stay within the composition timeline and select samples", () => {
	refused(setField(h264Aac(), `${video}/edts/elst`, 8, 200_000), /edit ends past/);
	refused(setField(h264Aac(), `${audio}/edts/elst`, 12, 97_024), /edit starts outside/);
	// Composition offsets place every frame at 20–22 s while the edit selects 0–2 s.
	const late = rewrite(h264Aac(), `${stbl(video)}/ctts`, () => rows([24, 20 * 12288]));
	refused(late, /edit starts outside/);
	refused(setField(h264Aac(), `${video}/edts/elst`, 16, 0x20000), /edit rate/);
	const twoEdits = rewrite(h264Aac(), `${video}/edts/elst`, (data) => {
		const out = Buffer.concat([data, data.subarray(8)]);
		out.writeUInt32BE(2, 4);
		return out;
	});
	refused(twoEdits, /leading empty edit/);
});

test("the presented edit cannot be the empty-edit sentinel", () => {
	// Signed offsets 2,049 ticks earlier start composition at -1, the sentinel's media_time.
	let sentinel = rewrite(h264Aac(), `${stbl(video)}/ctts`, (data) => {
		const out = Buffer.from(data);
		out[0] = 1;
		for (let at = 12; at < out.length; at += 8) out.writeInt32BE(out.readUInt32BE(at) - 2049, at);
		return out;
	});
	sentinel = setField(sentinel, `${video}/edts/elst`, 12, 0xffffffff);
	refused(sentinel, /presented edit media time/);
});

test("ctts must cover exactly the track's samples", () => {
	refused(
		rewrite(h264Aac(), `${stbl(video)}/ctts`, () => rows([25, 0])),
		/ctts/,
	);
});

test("samples stay inside media data and the movie is self-contained and unencrypted", () => {
	refused(setField(h264Aac(), `${stbl(video)}/stco`, 8, 0), /chunk outside media data/);
	refused(
		setField(h264Aac(), `${video}/mdia/minf/dinf/dref/url `, 0, 0),
		/external media reference/,
	);
	const encrypted = Buffer.from(h264Aac());
	const entry = locate(encrypted, `${stbl(video)}/stsd/avc1`).at(-1);
	encrypted.write("encv", (entry?.start ?? 0) + 4, "latin1");
	refused(encrypted, /encv is not allowed/);
	refused(appendChild(h264Aac(), "moov", box("mvex")), /mvex is not allowed/);
	refused(setField(h264Aac(), `${stbl(audio)}/stsc`, 12, 2), /stsc|chunk map|overlapping/);
});

// AAC priming as some muxers write it: the audio mdhd leaves out the one access unit
// (1,024 samples at 48 kHz) that the edit skips.
const primed = (bytes: Buffer) => setField(bytes, `${audio}/mdia/mdhd`, 16, 97_024 - 1024);
const audioEdit = (bytes: Buffer, time: number, segment: number) =>
	setField(setField(bytes, `${audio}/edts/elst`, 12, time), `${audio}/edts/elst`, 8, segment);
const audioCtts = (offset: number) => box("ctts", rows([95, offset]));
/** The fixture's AudioSpecificConfig with frameLengthFlag set: 960-sample frames. */
const shortFrames = (bytes: Buffer) =>
	rewrite(bytes, `${stbl(audio)}/stsd/mp4a/esds`, (data) => {
		const at = data.indexOf(Buffer.from([0x05, 0x80, 0x80, 0x80, 0x05, 0x11, 0x88]));
		if (at < 0) throw new Error("Fixture esds moved.");
		const out = Buffer.from(data);
		out[at + 6] |= 0x04;
		return out;
	});
/** Audio decode deltas whose first sample ends before the edit's media time. */
const shortFirstSample = (bytes: Buffer) =>
	rewrite(bytes, `${stbl(audio)}/stts`, () => rows([1, 512], [1, 1536], [92, 1024], [1, 768]));

test("an AAC header that excludes one access unit of edit priming passes", () => {
	expect(inspect(primed(h264Aac()))).toEqual(inspect(h264Aac()));
	expect(inspect(appendChild(primed(h264Aac()), stbl(audio), audioCtts(0)))).toMatchObject({
		duration: 2,
	});
	// The edit may end one movie tick before the decode end.
	expect(inspect(audioEdit(primed(h264Aac()), 1024, 96_000 - 1))).toMatchObject({ duration: 2 });
});

test("priming is excused only for one AAC access unit skipped by the single edit", () => {
	const differs = /stts duration differs from mdhd/;
	refused(setField(h264Aac(), `${video}/mdia/mdhd`, 16, 24_576 - 2048), differs);
	refused(setField(h264Aac(), `${audio}/mdia/mdhd`, 16, 97_023), differs);
	refused(setField(h264Aac(), `${audio}/mdia/mdhd`, 16, 97_025), differs);
	refused(replaceBox(primed(h264Aac()), `${audio}/edts`, null), differs);
	const leadingEmpty = rewrite(primed(h264Aac()), `${audio}/edts/elst`, (data) => {
		const empty = Buffer.alloc(12);
		empty.writeInt32BE(-1, 4);
		empty.writeUInt32BE(0x10000, 8);
		const out = Buffer.concat([data.subarray(0, 8), empty, data.subarray(8)]);
		out.writeUInt32BE(2, 4);
		return out;
	});
	refused(leadingEmpty, differs);
	refused(appendChild(primed(h264Aac()), stbl(audio), audioCtts(1)), differs);
	refused(audioEdit(primed(h264Aac()), 1024, 96_000 - 2), differs);
	refused(shortFrames(primed(h264Aac())), differs);
	refused(shortFirstSample(primed(h264Aac())), differs);
	// Two frames of priming: the edit itself is valid, so only the priming rule refuses it.
	const twoFrames = audioEdit(h264Aac(), 2048, 94_976);
	expect(inspect(twoFrames)).toMatchObject({ duration: 2 });
	refused(setField(twoFrames, `${audio}/mdia/mdhd`, 16, 97_024 - 2048), differs);
	// Neither guard refuses a clip whose header already equals its decode duration.
	expect(inspect(shortFrames(h264Aac()))).toMatchObject({ duration: 2 });
	expect(inspect(shortFirstSample(h264Aac()))).toMatchObject({ duration: 2 });
});
