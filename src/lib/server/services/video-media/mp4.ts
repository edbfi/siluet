import { checkAacConfig } from "./aac";
import { checkAvcConfig, checkTransfer } from "./avc";
import { check } from "./errors";
import { areaLimit, edgeLimit, presentedSecondsLimit } from "./limits";
import { type Box, boxWalker, fields, movieRules, only } from "./mp4-boxes";

// Checks a buffered `moov` against the file's `mdat` spans (D6). Sample tables must
// map every sample into media data, and each track's timeline must agree with its
// header and edit list. The browser validates the coded samples when it plays them.

export type Span = { start: number; end: number };
type Walker = ReturnType<typeof boxWalker>;
/** A duration in movie-timescale ticks, as the fraction num / den. */
type Ticks = { num: bigint; den: bigint };

const brands = ["isom", "iso2", "iso4", "iso5", "iso6", "mp41", "mp42", "avc1", "M4V "];
// Twelve seconds at 60 frames per second, and at 48 kHz AAC plus encoder priming.
const sampleLimit = { video: 720, audio: 580 } as const;

/** Timescale and duration from an `mvhd` or `mdhd` payload. */
function header(box: Box) {
	const read = fields(box);
	const version = read.u8(0);
	check(version <= 1, `${box.type} version`);
	const scale = version ? read.u32(20) : read.u32(12);
	const duration = version ? read.u64(24) : read.u32(16);
	check(scale > 0, `${box.type} timescale`);
	return { scale, duration };
}

/** Entries of a full-box table whose rows are `width` bytes after an entry count. */
function table(box: Box, width: number, max: number) {
	const read = fields(box);
	const count = read.u32(4);
	check(count > 0 && count <= max && read.length === 8 + count * width, `${box.type} entries`);
	return { read, count, row: (i: number) => 8 + i * width };
}

function sampleEntry(walk: Walker, stbl: Box[], video: boolean) {
	const description = only(stbl, "stsd");
	check(fields(description).u32(4) === 1, "one sample description");
	const entries = walk.children(description);
	check(entries.length === 1, "one sample description");
	const [entry] = entries;
	check(
		entry.type === (video ? "avc1" : "mp4a"),
		`${entry.type} in a ${video ? "video" : "sound"} track`,
	);
	const read = fields(entry);
	check(read.u16(6) === 1, "data reference index");
	const extensions = walk.children(entry);
	if (!video) {
		check(read.u16(8) === 0, "sound sample entry version");
		checkAacConfig(only(extensions, "esds").data);
		return null;
	}
	const width = read.u16(24);
	const height = read.u16(26);
	check(
		width > 0 &&
			height > 0 &&
			width <= edgeLimit &&
			height <= edgeLimit &&
			width * height <= areaLimit,
		"picture size",
	);
	checkAvcConfig(only(extensions, "avcC").data, width, height);
	for (const color of extensions.filter((b) => b.type === "colr")) {
		const value = fields(color);
		check(["nclx", "nclc"].includes(value.latin1(0, 4)), "colour description");
		checkTransfer(value.u16(6));
	}
	return { width, height };
}

/** Each sample's decode time, composition offset and duration, in media ticks. */
function timing(stbl: Box[], samples: number, limit: number) {
	const decode = table(only(stbl, "stts"), 8, limit);
	const durations: number[] = [];
	for (let i = 0; i < decode.count; i++) {
		const count = decode.read.u32(decode.row(i));
		const delta = decode.read.u32(decode.row(i) + 4);
		check(count > 0 && delta > 0 && durations.length + count <= samples, "stts entries");
		for (let j = 0; j < count; j++) durations.push(delta);
	}
	check(durations.length === samples, "stts sample count");
	const offsets = new Array<number>(samples).fill(0);
	const ctts = stbl.filter((b) => b.type === "ctts");
	check(ctts.length <= 1, "one ctts");
	if (ctts.length) {
		const composition = table(ctts[0], 8, limit);
		const signed = composition.read.u8(0) === 1;
		check(composition.read.u8(0) <= 1, "ctts version");
		let sample = 0;
		for (let i = 0; i < composition.count; i++) {
			const count = composition.read.u32(composition.row(i));
			const offset = signed
				? composition.read.i32(composition.row(i) + 4)
				: composition.read.u32(composition.row(i) + 4);
			check(count > 0 && sample + count <= samples, "ctts entries");
			for (let j = 0; j < count; j++) offsets[sample++] = offset;
		}
		check(sample === samples, "ctts sample count");
	}
	return { durations, offsets };
}

/** Map every sample into one `mdat` span and record its byte range. */
function placement(stbl: Box[], media: Span[], occupied: Span[], limit: number) {
	const sizes = fields(only(stbl, "stsz"));
	const fixed = sizes.u32(4);
	const samples = sizes.u32(8);
	check(samples > 0 && samples <= limit, "sample count");
	check(sizes.length === 12 + (fixed ? 0 : samples * 4), "stsz entries");
	const offsets = stbl.filter((b) => b.type === "co64" || b.type === "stco");
	check(offsets.length === 1, "one chunk offset table");
	const wide = offsets[0].type === "co64";
	const chunks = table(offsets[0], wide ? 8 : 4, limit);
	const mapping = table(only(stbl, "stsc"), 12, chunks.count);
	let previous = 0;
	for (let i = 0; i < mapping.count; i++) {
		const first = mapping.read.u32(mapping.row(i));
		check(
			first > previous &&
				first <= chunks.count &&
				mapping.read.u32(mapping.row(i) + 4) > 0 &&
				mapping.read.u32(mapping.row(i) + 8) === 1,
			"stsc entries",
		);
		previous = first;
	}
	check(mapping.read.u32(mapping.row(0)) === 1, "stsc starts at the first chunk");
	let sample = 0;
	let run = 0;
	for (let i = 0; i < chunks.count; i++) {
		if (run + 1 < mapping.count && mapping.read.u32(mapping.row(run + 1)) === i + 1) run++;
		const start = wide ? chunks.read.u64(chunks.row(i)) : chunks.read.u32(chunks.row(i));
		const count = mapping.read.u32(mapping.row(run) + 4);
		check(sample + count <= samples, "chunk map exceeds the sample count");
		let end = start;
		for (let j = 0; j < count; j++, sample++) {
			const length = fixed || sizes.u32(12 + sample * 4);
			check(length > 0, "empty sample");
			end += length;
		}
		check(
			media.some((span) => start >= span.start && end <= span.end),
			"chunk outside media data",
		);
		occupied.push({ start, end });
	}
	check(sample === samples, "chunk map misses samples");
	return samples;
}

/** The presented duration of one track in movie ticks, from its composition timeline and edits. */
function presentation(
	walk: Walker,
	trak: Box[],
	movieScale: number,
	media: { scale: number; durations: number[]; offsets: number[] },
): Ticks {
	let decode = 0;
	let earliest = Number.POSITIVE_INFINITY;
	let end = Number.NEGATIVE_INFINITY;
	const starts: number[] = [];
	const ends: number[] = [];
	for (const [i, duration] of media.durations.entries()) {
		const start = decode + media.offsets[i];
		starts.push(start);
		ends.push(start + duration);
		earliest = Math.min(earliest, start);
		end = Math.max(end, start + duration);
		decode += duration;
	}
	const edits = trak.filter((b) => b.type === "edts");
	check(edits.length <= 1, "one edit box");
	const movie = BigInt(movieScale);
	const scale = BigInt(media.scale);
	if (!edits.length) {
		check(earliest >= 0, "composition before the presentation start");
		return { num: BigInt(end) * movie, den: scale };
	}
	const list = fields(only(walk.children(edits[0]), "elst"));
	const version = list.u8(0);
	check(version <= 1, "elst version");
	const width = version ? 20 : 12;
	const count = list.u32(4);
	check(count >= 1 && count <= 2 && list.length === 8 + count * width, "edit list shape");
	const edit = (i: number) => {
		const at = 8 + i * width;
		return {
			segment: version ? list.u64(at) : list.u32(at),
			time: version ? list.i64(at + 8) : list.i32(at + 4),
			rate: list.u32(at + (version ? 16 : 8)),
		};
	};
	const empty = count === 2 ? edit(0) : null;
	check(!empty || empty.time === -1, "only one leading empty edit");
	const { segment, time, rate } = edit(count - 1);
	check(rate === 0x10000, "edit rate other than 1");
	check(segment > 0, "empty presented edit");
	check(time >= 0, "presented edit media time");
	// The edit starts inside the composition timeline and ends within one movie tick of it.
	check(time >= earliest && time < end, "edit starts outside the composition timeline");
	const first = BigInt(time);
	const length = BigInt(segment);
	check(
		(length - 1n) * scale <= (BigInt(end) - first) * movie,
		"edit ends past the composition timeline",
	);
	check(
		starts.some(
			(start, i) => BigInt(start) * movie < first * movie + length * scale && ends[i] > time,
		),
		"edit selects no sample",
	);
	return { num: BigInt(segment + (empty?.segment ?? 0)), den: 1n };
}

function track(walk: Walker, trak: Box, media: Span[], occupied: Span[], movieScale: number) {
	const parts = walk.children(trak);
	only(parts, "tkhd");
	const mdia = walk.children(only(parts, "mdia"));
	const { scale, duration } = header(only(mdia, "mdhd"));
	const handler = fields(only(mdia, "hdlr")).latin1(8, 4);
	check(handler === "vide" || handler === "soun", `${handler} track`);
	const video = handler === "vide";
	const limit = sampleLimit[video ? "video" : "audio"];
	const minf = walk.children(only(mdia, "minf"));
	const dref = only(walk.children(only(minf, "dinf")), "dref");
	check(fields(dref).u32(0) === 0 && fields(dref).u32(4) === 1, "one data reference");
	const references = walk.children(dref);
	check(
		references.length === 1 && references[0].data.equals(Buffer.from([0, 0, 0, 1])),
		"external media reference",
	);
	const stbl = walk.children(only(minf, "stbl"));
	for (const group of stbl.filter((b) => b.type === "sgpd" || b.type === "sbgp"))
		check(["roll", "prol"].includes(fields(group).latin1(4, 4)), "sample group");
	const picture = sampleEntry(walk, stbl, video);
	const samples = placement(stbl, media, occupied, limit);
	const { durations, offsets } = timing(stbl, samples, limit);
	check(
		durations.reduce((sum, value) => sum + value, 0) === duration,
		"stts duration differs from mdhd",
	);
	const presented = presentation(walk, parts, movieScale, { scale, durations, offsets });
	check(
		presented.num > 0n &&
			presented.num <= BigInt(presentedSecondsLimit) * BigInt(movieScale) * presented.den,
		"presented duration",
	);
	return { type: video ? ("video" as const) : ("audio" as const), samples, picture, presented };
}

/** Check `ftyp` and `moov` (complete boxes) against the file's `mdat` spans. */
export function inspectMovie(ftyp: Buffer, moov: Buffer, media: Span[]) {
	const walk = boxWalker(movieRules);
	const type = fields(walk.root(ftyp).data);
	check(
		type.length >= 8 && type.length % 4 === 0 && brands.includes(type.latin1(0, 4)),
		"file type",
	);
	const movie = walk.root(moov);
	check(movie.type === "moov", "movie box");
	const parts = walk.children(movie);
	const { scale, duration } = header(only(parts, "mvhd"));
	const traks = parts.filter((b) => b.type === "trak");
	check(traks.length >= 1 && traks.length <= 2, "track count");
	const occupied: Span[] = [];
	const tracks = traks.map((t) => track(walk, t, media, occupied, scale));
	const picture = tracks.find((t) => t.type === "video")?.picture;
	check(picture && tracks.filter((t) => t.type === "video").length === 1, "one video track");
	occupied.sort((a, b) => a.start - b.start);
	check(
		occupied.every((span, i) => !i || span.start >= occupied[i - 1].end),
		"overlapping samples",
	);
	// mvhd must equal the longest presented track within one movie tick.
	const longest = tracks
		.map((t) => t.presented)
		.reduce((a, b) => (a.num * b.den >= b.num * a.den ? a : b));
	const gap = BigInt(duration) * longest.den - longest.num;
	check(gap <= longest.den && gap >= -longest.den, "mvhd duration differs from the tracks");
	return {
		...picture,
		duration: Number(longest.num) / Number(longest.den) / scale,
		tracks: tracks.map(({ type, samples }) => ({ type, samples })),
	};
}
