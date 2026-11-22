// Check the stored ISO BMFF sample tables independently of FFmpeg's demuxer.
// Offsets below are relative to the payload (including FullBox version/flags).
export const videoByteLimit = 64 * 1024 * 1024;
export function ensure(condition: unknown): asserts condition {
	if (!condition) throw new Error("Unsupported video.");
}
type Box = { type: string; data: Buffer; start: number; end: number };
function boxes(bytes: Buffer, offset = 0) {
	const result: Box[] = [];
	while (offset < bytes.length) {
		ensure(result.length < 4096 && offset + 8 <= bytes.length);
		let size = bytes.readUInt32BE(offset);
		const type = bytes.toString("latin1", offset + 4, offset + 8);
		let header = 8;
		if (size === 1) {
			size = Number(bytes.readBigUInt64BE(offset + 8));
			header = 16;
		}
		ensure(size >= header && size <= bytes.length - offset);
		const start = offset + header;
		const end = offset + size;
		result.push({ type, data: bytes.subarray(start, end), start, end });
		offset = end;
	}
	return result;
}
function only(list: Box[], type: string) {
	const matches = list.filter((box) => box.type === type);
	ensure(matches.length === 1);
	return matches[0].data;
}
function rows(box: Buffer, width: number, max: number) {
	const count = box.readUInt32BE(4);
	ensure(count > 0 && count <= max && box.length === 8 + count * width);
	return Array.from({ length: count }, (_, i) => box.subarray(8 + i * width, 8 + (i + 1) * width));
}
function track(trak: Box, media: Box[], occupied: { start: number; end: number }[]) {
	const mdia = boxes(only(boxes(trak.data), "mdia"));
	const handler = only(mdia, "hdlr").toString("latin1", 8, 12);
	ensure(handler === "vide" || handler === "soun");
	const video = handler === "vide";
	const limit = video ? 720 : 580; // Twelve seconds at 48 kHz plus encoder priming.
	const minf = boxes(only(mdia, "minf"));
	const dref = only(boxes(only(minf, "dinf")), "dref");
	ensure(dref.readUInt32BE(0) === 0 && dref.readUInt32BE(4) === 1);
	const references = boxes(dref, 8);
	ensure(
		references.length === 1 &&
			references[0].type === "url " &&
			references[0].data.equals(Buffer.from([0, 0, 0, 1])),
	);
	const table = boxes(only(minf, "stbl"));
	// Only the ordinary, unencrypted sample-table representation is qualified.
	ensure(
		table.every((b) =>
			[
				"stsd",
				"stts",
				"ctts",
				"stss",
				"stsc",
				"stsz",
				"stco",
				"co64",
				"sdtp",
				"sgpd",
				"sbgp",
			].includes(b.type),
		),
	);
	for (const group of table.filter((b) => b.type === "sgpd" || b.type === "sbgp"))
		ensure(["roll", "prol"].includes(group.data.toString("latin1", 4, 8)));
	const description = only(table, "stsd");
	ensure(description.readUInt32BE(4) === 1);
	const entries = boxes(description, 8);
	ensure(
		entries.length === 1 &&
			entries[0].type === (video ? "avc1" : "mp4a") &&
			entries[0].data.readUInt16BE(6) === 1,
	);
	const extensions = boxes(entries[0].data, video ? 78 : 28);
	ensure(
		extensions.every((b) =>
			(video ? ["avcC", "btrt", "pasp", "colr", "clap"] : ["esds", "btrt"]).includes(b.type),
		),
	);
	only(extensions, video ? "avcC" : "esds");
	for (const color of extensions.filter((b) => b.type === "colr")) {
		ensure(["nclx", "nclc"].includes(color.data.toString("latin1", 0, 4)));
		ensure([1, 2, 4, 5, 6, 13].includes(color.data.readUInt16BE(6)));
	}
	const sizes = only(table, "stsz");
	const fixed = sizes.readUInt32BE(4);
	const samples = sizes.readUInt32BE(8);
	ensure(samples > 0 && samples <= limit && sizes.length === 12 + (fixed ? 0 : samples * 4));
	for (const type of ["stts", "ctts"]) {
		if (type === "ctts" && !table.some((b) => b.type === type)) continue;
		const counts = rows(only(table, type), 8, limit);
		ensure(
			counts.every(
				(row) => row.readUInt32BE(0) > 0 && (type !== "stts" || row.readUInt32BE(4) > 0),
			),
		);
		ensure(counts.reduce((sum, row) => sum + row.readUInt32BE(0), 0) === samples);
	}
	const offsets = table.filter((b) => b.type === "co64" || b.type === "stco");
	ensure(offsets.length === 1);
	const wide = offsets[0].type === "co64";
	const chunks = rows(offsets[0].data, wide ? 8 : 4, limit);
	const mapping = rows(only(table, "stsc"), 12, chunks.length);
	let previous = 0;
	for (const row of mapping) {
		const first = row.readUInt32BE(0);
		ensure(
			first > previous &&
				first <= chunks.length &&
				row.readUInt32BE(4) > 0 &&
				row.readUInt32BE(8) === 1,
		);
		previous = first;
	}
	ensure(mapping[0].readUInt32BE(0) === 1);
	let sample = 0;
	let run = 0;
	for (const [i, chunk] of chunks.entries()) {
		if (mapping[run + 1]?.readUInt32BE(0) === i + 1) run++;
		const start = wide ? Number(chunk.readBigUInt64BE()) : chunk.readUInt32BE();
		let end = start;
		const count = mapping[run].readUInt32BE(4);
		ensure(sample + count <= samples);
		for (let j = 0; j < count; j++, sample++) {
			const length = fixed || sizes.readUInt32BE(12 + sample * 4);
			ensure(length > 0);
			end += length;
		}
		ensure(media.some((b) => start >= b.start && end <= b.end));
		occupied.push({ start, end });
	}
	ensure(sample === samples);
	return { type: video ? ("video" as const) : ("audio" as const), samples };
}
export function inspectMp4(bytes: Buffer) {
	ensure(bytes.length <= videoByteLimit);
	const top = boxes(bytes);
	const ftyp = only(top, "ftyp");
	ensure(
		ftyp.length >= 8 &&
			ftyp.length % 4 === 0 &&
			["isom", "iso2", "iso4", "iso5", "iso6", "mp41", "mp42", "avc1", "M4V "].includes(
				ftyp.toString("latin1", 0, 4),
			),
	);
	ensure(top.every((b) => ["ftyp", "moov", "mdat", "free", "wide", "skip"].includes(b.type)));
	const movie = boxes(only(top, "moov"));
	ensure(movie.every((b) => ["mvhd", "trak", "udta", "meta", "free"].includes(b.type)));
	const tracks = movie.filter((b) => b.type === "trak");
	ensure(tracks.length >= 1 && tracks.length <= 2);
	const occupied: { start: number; end: number }[] = [];
	const info = tracks.map((t) =>
		track(
			t,
			top.filter((b) => b.type === "mdat"),
			occupied,
		),
	);
	ensure(info.filter((t) => t.type === "video").length === 1);
	occupied.sort((a, b) => a.start - b.start);
	ensure(occupied.every((span, i) => !i || span.start >= occupied[i - 1].end));
	return info;
}
