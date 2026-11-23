import { expect, test } from "bun:test";
import { TruncatedVideoError, UnsupportedVideoError } from "./errors";
import { boxHeader, boxWalker, movieRules } from "./mp4-boxes";

const box = (type: string, ...payload: Buffer[]) => {
	const data = Buffer.concat(payload);
	const head = Buffer.alloc(8);
	head.writeUInt32BE(8 + data.length);
	head.write(type, 4, "latin1");
	return Buffer.concat([head, data]);
};
const truncated = () => new TruncatedVideoError();

function thrown(work: () => unknown) {
	try {
		work();
	} catch (error) {
		return error;
	}
	throw new Error("Expected a refusal.");
}

test("a truncated 64-bit header and a size past the end are truncation, never RangeError", () => {
	const wide = Buffer.alloc(12);
	wide.writeUInt32BE(1);
	wide.write("mdat", 4, "latin1");
	expect(thrown(() => boxHeader(wide, 0, wide.length, truncated))).toBeInstanceOf(
		TruncatedVideoError,
	);
	const past = box("mdat", Buffer.alloc(8));
	expect(thrown(() => boxHeader(past, 0, past.length - 1, truncated))).toBeInstanceOf(
		TruncatedVideoError,
	);
	expect(thrown(() => boxHeader(Buffer.alloc(3), 0, 3, truncated))).toBeInstanceOf(
		TruncatedVideoError,
	);
});

test("64-bit sizes are read as BigInt and refused above the safe integer range", () => {
	const wide = Buffer.alloc(16);
	wide.writeUInt32BE(1);
	wide.write("mdat", 4, "latin1");
	wide.writeBigUInt64BE(BigInt(Number.MAX_SAFE_INTEGER) + 1n, 8);
	expect(thrown(() => boxHeader(wide, 0, Number.MAX_SAFE_INTEGER, truncated))).toBeInstanceOf(
		UnsupportedVideoError,
	);
	wide.writeBigUInt64BE(16n, 8);
	expect(boxHeader(wide, 0, 16, truncated)).toEqual({ type: "mdat", size: 16, header: 16 });
});

test("open-ended and undersized boxes are unsupported", () => {
	const open = box("mdat");
	open.writeUInt32BE(0);
	expect(thrown(() => boxHeader(open, 0, open.length, truncated))).toBeInstanceOf(
		UnsupportedVideoError,
	);
	const small = box("free");
	small.writeUInt32BE(7);
	expect(thrown(() => boxHeader(small, 0, small.length, truncated))).toBeInstanceOf(
		UnsupportedVideoError,
	);
});

test("children follow each container's allowlist, depth and box budget", () => {
	const movie = box("moov", box("trak", box("tkhd", Buffer.alloc(4)), box("tref")));
	const walk = boxWalker(movieRules);
	const [trak] = walk.children(walk.root(movie));
	const refusal = thrown(() => walk.children(trak));
	expect(refusal).toBeInstanceOf(UnsupportedVideoError);
	expect(String(refusal)).toContain("tref");

	let nested = box("deep");
	for (let i = 0; i < 7; i++) nested = box("nest", nested);
	const deep = boxWalker({ nest: ["nest", "deep"] });
	let level = [deep.root(nested)];
	const descend = () => {
		for (;;) level = deep.children(level[0]);
	};
	const tooDeep = thrown(descend);
	expect(tooDeep).toBeInstanceOf(UnsupportedVideoError);
	expect(String(tooDeep)).toContain("deep");

	const many = box("moov", ...Array.from({ length: 4097 }, () => box("free")));
	expect(thrown(() => boxWalker(movieRules).children(walk.root(many)))).toBeInstanceOf(
		UnsupportedVideoError,
	);
});

test("a child that overruns its parent is unsupported rather than truncated", () => {
	const inner = box("tkhd", Buffer.alloc(4));
	inner.writeUInt32BE(64);
	const walk = boxWalker(movieRules);
	const refusal = thrown(() => walk.children(walk.root(box("trak", inner))));
	expect(refusal).toBeInstanceOf(UnsupportedVideoError);
});
