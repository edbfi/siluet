import { expect, test } from "bun:test";
import {
	appendChild,
	box,
	h264Aac,
	locate,
	payload,
	replaceBox,
	retimeClip,
	rewrite,
	setAudioConfig,
	setField,
} from "../../../../../tests/fixtures/video/mp4-boxes";
import { UnsupportedVideoError } from "./errors";
import { inspectMovie } from "./mp4";

const video = "moov/trak#0";
const audio = "moov/trak#1";
const stbl = (track: string) => `${track}/mdia/minf/stbl`;

function inspect(bytes: Buffer, seconds: number | null = null) {
	const whole = (type: string) => {
		const node = locate(bytes, type)[0];
		return bytes.subarray(node.start, node.start + node.size);
	};
	const mdat = locate(bytes, "mdat")[0];
	return inspectMovie(
		whole("ftyp"),
		whole("moov"),
		[{ start: mdat.start + mdat.header, end: mdat.start + mdat.size }],
		seconds,
	);
}
const refused = (bytes: Buffer, reason: RegExp, seconds: number | null = null) => {
	expect(() => inspect(bytes, seconds)).toThrow(UnsupportedVideoError);
	expect(() => inspect(bytes, seconds)).toThrow(reason);
};
/** The first refusal's detail, or "passed". */
const refusal = (bytes: Buffer, seconds: number | null) => {
	try {
		inspect(bytes, seconds);
		return "passed";
	} catch (error) {
		if (!(error instanceof UnsupportedVideoError)) throw error;
		return error.detail;
	}
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

test("mvhd must match the presented tracks", () => {
	// 60 seconds of samples behind a 10-second mvhd.
	let long = setField(h264Aac(), `${video}/mdia/mdhd`, 16, 60 * 12288);
	long = rewrite(long, `${stbl(video)}/stts`, () => rows([24, (60 * 12288) / 24]));
	long = setField(long, "moov/mvhd", 16, 10 * 48000);
	refused(long, /mvhd duration/, 30);
	refused(replaceBox(long, `${video}/edts`, null), /presented duration/, 30);
});

/** The video edit one movie tick longer; mvhd stays within its one-tick rounding. */
const oneTickLonger = (bytes: Buffer) =>
	setField(
		bytes,
		`${video}/edts/elst`,
		8,
		payload(bytes, `${video}/edts/elst`).readUInt32BE(8) + 1,
	);

test.each([
	[15, 8, 1],
	[30, 31, 2],
])(
	"a %i-second limit saves its limit plus one second and refuses one movie tick over",
	(limit, num, den) => {
		const edge = retimeClip(h264Aac(), num, den);
		expect(inspect(edge, limit)).toMatchObject({ duration: limit + 1 });
		refused(oneTickLonger(edge), /presented duration/, limit);
	},
);

test("a job with no limit keeps 12 seconds with no allowance", () => {
	const twelve = retimeClip(h264Aac(), 6);
	expect(inspect(twelve)).toMatchObject({ duration: 12 });
	refused(oneTickLonger(twelve), /presented duration/);
	const thirteen = retimeClip(h264Aac(), 13, 2);
	refused(thirteen, /presented duration/);
	expect(inspect(thirteen, 15)).toMatchObject({ duration: 13 });
});

test("the reported duration never exceeds the bound", () => {
	for (const [num, den] of [
		[31, 2],
		[93, 6],
		[217, 14],
	])
		expect(inspect(retimeClip(h264Aac(), num, den), 30).duration).toBeLessThanOrEqual(31);
});

test("a bad Save limit is a programming error raised before any parsing", () => {
	for (const seconds of [0, -1, 15.5, 61, Number.NaN, undefined])
		expect(() => inspectMovie(Buffer.alloc(0), Buffer.alloc(0), [], seconds as number)).toThrow(
			TypeError,
		);
});

/** A track whose `stsz` declares `count` one-byte samples; later checks still refuse it. */
const sampleCount = (bytes: Buffer, track: string, count: number) =>
	rewrite(bytes, `${stbl(track)}/stsz`, () => {
		const data = Buffer.alloc(12);
		data.writeUInt32BE(1, 4);
		data.writeUInt32BE(count, 8);
		return data;
	});

test.each([
	[30, 1860],
	[15, 960],
	[null, 720],
])("a %p-second limit bounds video at %i samples", (limit, max) => {
	expect(refusal(sampleCount(h264Aac(), video, max), limit)).toBe("chunk map misses samples");
	expect(refusal(sampleCount(h264Aac(), video, max + 1), limit)).toBe("sample count");
});

test.each([
	[30, 1471, 1567],
	[15, 767, 817],
	[null, 580, 580],
])("a %p-second limit bounds AAC at %i samples of 1,024 and %i of 960", (limit, long, short) => {
	for (const [frames, max] of [
		[h264Aac(), long],
		[shortFrames(h264Aac()), short],
	] as const) {
		expect(refusal(sampleCount(frames, audio, max), limit)).toBe("chunk map misses samples");
		expect(refusal(sampleCount(frames, audio, max + 1), limit)).toBe("sample count");
	}
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

test("a version-1 empty edit and presented edit that sum past the safe range are refused", () => {
	const wide = rewrite(h264Aac(), `${video}/edts/elst`, (data) => {
		const entry = (segment: number, time: number) => {
			const out = Buffer.alloc(20);
			out.writeBigUInt64BE(BigInt(segment));
			out.writeBigInt64BE(BigInt(time), 8);
			out.writeUInt32BE(0x10000, 16);
			return out;
		};
		const segment = data.readUInt32BE(8);
		// Each fits in a safe integer; their sum does not.
		const empty = Number.MAX_SAFE_INTEGER - segment + 1;
		const out = Buffer.concat([
			data.subarray(0, 8),
			entry(empty, -1),
			entry(segment, data.readInt32BE(12)),
		]);
		out[0] = 1;
		out.writeUInt32BE(2, 4);
		return out;
	});
	expect(refusal(wide, null)).toMatch(/presented duration/);
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
	// At 44.1 kHz one access unit is 1,114.56 ticks of the 48 kHz media timescale.
	const at44k = setAudioConfig(h264Aac(), Buffer.from("120856e500", "hex"));
	expect(inspect(at44k)).toMatchObject({ duration: 2 });
	refused(primed(at44k), differs);
	// Two frames of priming: the edit itself is valid, so only the priming rule refuses it.
	const twoFrames = audioEdit(h264Aac(), 2048, 94_976);
	expect(inspect(twoFrames)).toMatchObject({ duration: 2 });
	refused(setField(twoFrames, `${audio}/mdia/mdhd`, 16, 97_024 - 2048), differs);
	// Neither guard refuses a clip whose header already equals its decode duration.
	expect(inspect(shortFrames(h264Aac()))).toMatchObject({ duration: 2 });
	expect(inspect(shortFirstSample(h264Aac()))).toMatchObject({ duration: 2 });
});
