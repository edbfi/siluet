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
