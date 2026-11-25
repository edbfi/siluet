import { readFileSync } from "node:fs";
import { join } from "node:path";

// Rewrites MP4 fixtures box by box for refusal tests. Paths name boxes from the top
// level, with `#n` selecting the nth sibling of a type: "moov/trak#1/mdia/mdhd".

/** H.264 96×64 2 s video and AAC-LC 48 kHz mono, with B-frames and edit lists. */
export const h264Aac = () => readFileSync(join(import.meta.dir, "h264-aac.mp4"));

type Node = { type: string; start: number; header: number; size: number };
const skips: Record<string, number> = {
	moov: 0,
	trak: 0,
	edts: 0,
	mdia: 0,
	minf: 0,
	dinf: 0,
	stbl: 0,
	stsd: 8,
	dref: 8,
	avc1: 78,
	mp4a: 28,
};

function children(bytes: Buffer, parent: Node | null) {
	const start = parent ? parent.start + parent.header + (skips[parent.type] ?? 0) : 0;
	const end = parent ? parent.start + parent.size : bytes.length;
	const result: Node[] = [];
	for (let at = start; at + 8 <= end; ) {
		let size = bytes.readUInt32BE(at);
		let header = 8;
		if (size === 1) {
			size = Number(bytes.readBigUInt64BE(at + 8));
			header = 16;
		}
		if (size < header) break;
		result.push({ type: bytes.toString("latin1", at + 4, at + 8), start: at, header, size });
		at += size;
	}
	return result;
}

/** The chain of boxes from the top level to `path`. */
export function locate(bytes: Buffer, path: string) {
	const chain: Node[] = [];
	for (const part of path.split("/")) {
		const [type, index = "0"] = part.split("#");
		const match = children(bytes, chain.at(-1) ?? null).filter((n) => n.type === type)[
			Number(index)
		];
		if (!match) throw new Error(`Fixture has no ${path}`);
		chain.push(match);
	}
	return chain;
}

/** A copy of the payload of the box at `path`. */
export function payload(bytes: Buffer, path: string) {
	const node = locate(bytes, path).at(-1) as Node;
	return Buffer.from(bytes.subarray(node.start + node.header, node.start + node.size));
}

export function box(type: string, ...parts: Buffer[]) {
	const data = Buffer.concat(parts);
	const head = Buffer.alloc(8);
	head.writeUInt32BE(8 + data.length);
	head.write(type, 4, "latin1");
	return Buffer.concat([head, data]);
}

/** Shift every chunk offset at or after `from` by `delta`. */
function shiftChunks(bytes: Buffer, from: number, delta: number) {
	const visit = (parent: Node | null) => {
		for (const node of children(bytes, parent)) {
			if (node.type === "stco" || node.type === "co64") {
				const wide = node.type === "co64";
				const base = node.start + node.header;
				const count = bytes.readUInt32BE(base + 4);
				for (let i = 0; i < count; i++) {
					const at = base + 8 + i * (wide ? 8 : 4);
					const value = wide ? Number(bytes.readBigUInt64BE(at)) : bytes.readUInt32BE(at);
					if (value < from) continue;
					if (wide) bytes.writeBigUInt64BE(BigInt(value + delta), at);
					else bytes.writeUInt32BE(value + delta, at);
				}
			} else if (node.type in skips) visit(node);
		}
	};
	visit(null);
}

/**
 * Replace the box at `path` with `next` (a complete box, or nothing to delete it),
 * fixing ancestor sizes and chunk offsets that follow the change.
 */
export function replaceBox(bytes: Buffer, path: string, next: Buffer | null) {
	const chain = locate(bytes, path);
	const node = chain.at(-1) as Node;
	const insert = next ?? Buffer.alloc(0);
	const delta = insert.length - node.size;
	const out = Buffer.concat([
		bytes.subarray(0, node.start),
		insert,
		bytes.subarray(node.start + node.size),
	]);
	for (const parent of chain.slice(0, -1)) {
		if (parent.header === 16) out.writeBigUInt64BE(BigInt(parent.size + delta), parent.start + 8);
		else out.writeUInt32BE(parent.size + delta, parent.start);
	}
	if (delta) shiftChunks(out, node.start + node.size, delta);
	return out;
}

/** Replace the payload of the box at `path`, keeping its type. */
export function rewrite(bytes: Buffer, path: string, change: (data: Buffer) => Buffer) {
	const type = (locate(bytes, path).at(-1) as Node).type;
	return replaceBox(bytes, path, box(type, change(payload(bytes, path))));
}

/** Append `child` to the end of the container at `path`. */
export function appendChild(bytes: Buffer, path: string, child: Buffer) {
	return rewrite(bytes, path, (data) => Buffer.concat([data, child]));
}

/** Write one big-endian field in the payload of the box at `path`. */
export function setField(
	bytes: Buffer,
	path: string,
	offset: number,
	value: number,
	width: 2 | 4 = 4,
) {
	const out = Buffer.from(bytes);
	const node = locate(out, path).at(-1) as Node;
	const at = node.start + node.header + offset;
	if (width === 2) out.writeUInt16BE(value, at);
	else out.writeUInt32BE(value, at);
	return out;
}

/**
 * Replace the audio track's AudioSpecificConfig, fixing the three `esds` descriptor lengths
 * around it. Expects h264Aac's layout: four-byte lengths and no optional ES fields.
 */
export function setAudioConfig(bytes: Buffer, config: Buffer) {
	return rewrite(bytes, "moov/trak#1/mdia/minf/stbl/stsd/mp4a/esds", (data) => {
		const [es, decoder, info] = [5, 13, 31];
		if (data[4] !== 3 || data[11] !== 0 || data[12] !== 4 || data[30] !== 5)
			throw new Error("Fixture esds moved.");
		const old = data[info + 3];
		const out = Buffer.concat([data.subarray(0, 35), config, data.subarray(35 + old)]);
		const delta = config.length - old;
		const length = (at: number, value: number) => out.writeUInt32BE(0x8080_8000 + value, at);
		length(es, data[es + 3] + delta);
		length(decoder, data[decoder + 3] + delta);
		length(info, config.length);
		return out;
	});
}

/**
 * h264Aac whose avcC PPS names a missing SPS (pps_id 0, sps_id 31). The declared
 * configuration verifies; no frame can decode, because the samples carry no
 * in-band parameter sets.
 */
export function undecodableH264Aac() {
	return rewrite(h264Aac(), "moov/trak/mdia/minf/stbl/stsd/avc1/avcC", (data) => {
		const spsLength = data.readUInt16BE(6);
		const ppsAt = 8 + spsLength;
		const ppsLength = data.readUInt16BE(ppsAt + 1);
		const pps = Buffer.from([0x68, 0x82, 0x08]);
		const length = Buffer.from([0, pps.length]);
		return Buffer.concat([
			data.subarray(0, ppsAt + 1),
			length,
			pps,
			data.subarray(ppsAt + 3 + ppsLength),
		]);
	});
}

/** Fields of a C2PA manifest box that refusal tests change (C2PA 2.2 §A.5.1.2, §11.1.4.2). */
export type ContentCredentialsShape = {
	/** The `uuid` extended type, as hex. */
	extendedType?: string;
	/** The FullBox version and flags as one 32-bit word. */
	versionFlags?: number;
	purpose?: string;
	merkleOffset?: bigint;
	/** The type of the box that should be the `jumb` manifest store. */
	storeBox?: string;
	/** The store's size, when it should not fill the rest of the box. */
	storeSize?: number;
	/** The `jumd` content type, as hex. */
	storeType?: string;
	toggles?: number;
	label?: string;
	/** 64-bit headers for the `uuid` box or the `jumb` store. */
	wideBox?: boolean;
	wideStore?: boolean;
};

/**
 * A synthetic C2PA manifest box of `size` bytes: a `manifest` FullBox with a zero Merkle offset
 * whose `jumb` store fills the box, led by a 30-byte `jumd` (C2PA store type, toggles 3,
 * label `c2pa`) and zero fill. A size below the full headers cuts the box short, its store
 * size clamped at 0 when the store starts past the end.
 */
export function c2paBox(size: number, shape: ContentCredentialsShape = {}) {
	const out = Buffer.alloc(Math.max(size, 128));
	const header = shape.wideBox ? 16 : 8;
	if (shape.wideBox) {
		out.writeUInt32BE(1, 0);
		out.writeBigUInt64BE(BigInt(size), 8);
	} else out.writeUInt32BE(size, 0);
	out.write("uuid", 4, "latin1");
	Buffer.from(shape.extendedType ?? "d8fec3d61b0e483c92975828877ec481", "hex").copy(out, header);
	out.writeUInt32BE(shape.versionFlags ?? 0, header + 16);
	const purpose = `${shape.purpose ?? "manifest"}\0`;
	out.write(purpose, header + 20, "latin1");
	out.writeBigUInt64BE(shape.merkleOffset ?? 0n, header + 20 + purpose.length);
	const store = header + 28 + purpose.length;
	const storeSize = shape.storeSize ?? Math.max(0, size - store);
	let description = store + 8;
	if (shape.wideStore) {
		out.writeUInt32BE(1, store);
		out.writeBigUInt64BE(BigInt(storeSize), store + 8);
		description = store + 16;
	} else out.writeUInt32BE(storeSize, store);
	out.write(shape.storeBox ?? "jumb", store + 4, "latin1");
	out.writeUInt32BE(30, description);
	out.write("jumd", description + 4, "latin1");
	Buffer.from(shape.storeType ?? "6332706100110010800000aa00389b71", "hex").copy(
		out,
		description + 8,
	);
	out[description + 24] = shape.toggles ?? 3;
	out.write(`${shape.label ?? "c2pa"}\0`, description + 25, "latin1");
	return out.subarray(0, size);
}

/** The complete bytes of the first top-level box of `type`. */
export function topLevelBox(bytes: Buffer, type: string) {
	const node = locate(bytes, type)[0];
	return Buffer.from(bytes.subarray(node.start, node.start + node.size));
}

/** Insert `boxes` straight after `ftyp`, shifting chunk offsets. */
export function afterFileType(bytes: Buffer, ...boxes: Buffer[]) {
	return replaceBox(bytes, "ftyp", Buffer.concat([topLevelBox(bytes, "ftyp"), ...boxes]));
}

/** Move a faststart file's `moov` to the end, after its media, keeping chunk offsets valid. */
export function moveMovieAfterMedia(bytes: Buffer) {
	const [moov] = locate(bytes, "moov");
	const movie = topLevelBox(bytes, "moov");
	const out = Buffer.concat([
		bytes.subarray(0, moov.start),
		bytes.subarray(moov.start + moov.size),
		movie,
	]);
	const at = out.length - movie.length;
	const moved = Buffer.from(out.subarray(at));
	shiftChunks(moved, moov.start + moov.size, -moov.size);
	moved.copy(out, at);
	return out;
}
