import { check, UnsupportedVideoError } from "./errors";

// Bounds-checked ISO BMFF box reading. Every read is checked against its parent
// or the file, so malformed sizes surface as typed refusals, never RangeError.

export type Box = { type: string; data: Buffer; depth: number };
type Rule = readonly string[] | { readonly skip: number; readonly allow: readonly string[] };
export type Rules = Readonly<Record<string, Rule>>;

// Container levels below a top-level box: trak, mdia, minf, stbl, stsd and a sample entry.
const maxDepth = 6;
const maxBoxes = 4096;

/** The containers Siluet descends into below `moov`, with their allowed children. */
export const movieRules: Rules = {
	moov: ["mvhd", "trak", "udta", "meta", "free"],
	trak: ["tkhd", "edts", "mdia", "udta"],
	edts: ["elst"],
	mdia: ["mdhd", "hdlr", "minf"],
	minf: ["vmhd", "smhd", "dinf", "stbl"],
	dinf: ["dref"],
	dref: { skip: 8, allow: ["url "] },
	// Only the ordinary, unencrypted sample-table representation is accepted.
	stbl: ["stsd", "stts", "ctts", "stss", "stsc", "stsz", "stco", "co64", "sdtp", "sgpd", "sbgp"],
	stsd: { skip: 8, allow: ["avc1", "mp4a"] },
	avc1: { skip: 78, allow: ["avcC", "btrt", "pasp", "colr", "clap"] },
	mp4a: { skip: 28, allow: ["esds", "btrt"] },
};

/**
 * Read the header at `at`. `room` is the space left in the enclosing file or box;
 * `overrun` builds the error for a header or size that does not fit in it.
 */
export function boxHeader(bytes: Buffer, at: number, room: number, overrun: () => Error) {
	if (room < 8 || bytes.length < at + 8) throw overrun();
	let size = bytes.readUInt32BE(at);
	const type = bytes.toString("latin1", at + 4, at + 8);
	let header = 8;
	if (size === 1) {
		if (room < 16 || bytes.length < at + 16) throw overrun();
		const wide = bytes.readBigUInt64BE(at + 8);
		check(wide <= BigInt(Number.MAX_SAFE_INTEGER), "box size beyond the safe integer range");
		size = Number(wide);
		header = 16;
	} else check(size !== 0, "open-ended box");
	check(size >= header, "box smaller than its header");
	if (size > room) throw overrun();
	return { type, size, header };
}

const malformed = () => new UnsupportedVideoError("box overruns its parent");

/** Walk boxes under `rules`, counting every box against one budget. */
export function boxWalker(rules: Rules) {
	let count = 0;
	return {
		/** A box whose complete bytes, header included, are already in memory. */
		root(bytes: Buffer): Box {
			const { type, size, header } = boxHeader(bytes, 0, bytes.length, malformed);
			check(size === bytes.length, "box size disagrees with its bytes");
			check(++count <= maxBoxes, "too many boxes");
			return { type, data: bytes.subarray(header, size), depth: 0 };
		},
		children(parent: Box): Box[] {
			const rule = rules[parent.type];
			check(rule, `${parent.type} is not a container`);
			const { skip, allow } = "allow" in rule ? rule : { skip: 0, allow: rule };
			check(parent.depth <= maxDepth, "boxes nest too deeply");
			const depth = parent.depth + 1;
			check(parent.data.length >= skip, `${parent.type} is too short`);
			const result: Box[] = [];
			let at = skip;
			while (at < parent.data.length) {
				const { type, size, header } = boxHeader(
					parent.data,
					at,
					parent.data.length - at,
					malformed,
				);
				check(++count <= maxBoxes, "too many boxes");
				check(allow.includes(type), `${type} is not allowed in ${parent.type}`);
				result.push({ type, data: parent.data.subarray(at + header, at + size), depth });
				at += size;
			}
			return result;
		},
	};
}

/** The single child of `type`; refuses a missing or repeated box. */
export function only(list: Box[], type: string) {
	const matches = list.filter((box) => box.type === type);
	check(matches.length === 1, `expected one ${type}`);
	return matches[0];
}

/** Checked big-endian reads within one box payload. */
export function fields(box: Box | Buffer) {
	const data = Buffer.isBuffer(box) ? box : box.data;
	const name = Buffer.isBuffer(box) ? "box" : box.type;
	const within = (at: number, width: number) =>
		check(at >= 0 && at + width <= data.length, `${name} is too short`);
	return {
		length: data.length,
		u8(at: number) {
			within(at, 1);
			return data[at];
		},
		u16(at: number) {
			within(at, 2);
			return data.readUInt16BE(at);
		},
		i16(at: number) {
			within(at, 2);
			return data.readInt16BE(at);
		},
		u32(at: number) {
			within(at, 4);
			return data.readUInt32BE(at);
		},
		i32(at: number) {
			within(at, 4);
			return data.readInt32BE(at);
		},
		u64(at: number) {
			within(at, 8);
			const value = data.readBigUInt64BE(at);
			check(value <= BigInt(Number.MAX_SAFE_INTEGER), `${name} value beyond the safe range`);
			return Number(value);
		},
		i64(at: number) {
			within(at, 8);
			const value = data.readBigInt64BE(at);
			check(
				value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= BigInt(Number.MIN_SAFE_INTEGER),
				`${name} value beyond the safe range`,
			);
			return Number(value);
		},
		latin1(at: number, width: number) {
			within(at, width);
			return data.toString("latin1", at, at + width);
		},
		bytes(at: number, width: number) {
			within(at, width);
			return data.subarray(at, at + width);
		},
	};
}
