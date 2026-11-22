function sampledCurve(values: number[]) {
	const tag = Buffer.alloc(12 + 2 * values.length);
	tag.write("curv");
	tag.writeUInt32BE(values.length, 8);
	for (const [index, value] of values.entries()) tag.writeUInt16BE(value, 12 + 2 * index);
	return tag;
}

function parametricCurve(kind: number, parameters: number[]) {
	const tag = Buffer.alloc(12 + 4 * parameters.length);
	tag.write("para");
	tag.writeUInt16BE(kind, 8);
	for (const [index, value] of parameters.entries()) {
		tag.writeInt32BE(Math.round(value * 65536), 12 + 4 * index);
	}
	return tag;
}

const lStar = [3, 1 / 1.16, 0.16 / 1.16, 2700 / 24389, 0.08];
const bt709 = [1 / 0.45, 1 / 1.099, 0.099 / 1.099, 1 / 4.5, 0.081];
const truncatedSrgb = [2.4, 1 / 1.055, 0.055 / 1.055, 1 / 12.92, 0.04045].map(
	(value) => Math.trunc(value * 65536) / 65536,
);

export const invalidCurves = [
	["unqualified truncated sRGB junction", parametricCurve(3, truncatedSrgb)],
	["BT.709-like junction with a nonzero offset", parametricCurve(4, [...bt709, 0, 1 / 65536])],
	["zero gamma", sampledCurve([0])],
	[
		"unqualified BT.709-like reversal",
		parametricCurve(3, [1 / 0.45, 1 / 1.099, 0.099 / 1.099 - 1 / 65536, 1 / 4.5, 0.081]),
	],
	["constant samples", sampledCurve([32768, 32768, 32768])],
	["reversing samples", sampledCurve([0, 32768, 16384, 65535])],
	["power branch outside the domain", parametricCurve(1, [1, 1, -1.5])],
	["constant clipped power curve", parametricCurve(2, [2, 1, 0, 1])],
	["downward junction", parametricCurve(3, [2, 1, 0, 1, 0.5])],
	["downward junction at the final input", parametricCurve(3, [1, 0.5, 0, 1, 1])],
	["negative active linear slope", parametricCurve(4, [1, 1, 0, -0.25, 0.5, 0, 0.25])],
	["constant after clipping both branches", parametricCurve(4, [1, 1, 0, 1, 0.5, 1.25, 1.125])],
	["one fixed-point step downward", parametricCurve(4, [1, 1, 0, 1, 0.5, 0, 1 / 65536])],
] as const;

export const validCurves = [
	["published L* junction", parametricCurve(3, lStar)],
	["published BT.709 junction", parametricCurve(3, bt709)],
	["published BT.709 junction with zero offsets", parametricCurve(4, [...bt709, 0, 0])],
	["identity", sampledCurve([])],
	["positive sampled gamma", sampledCurve([563])],
	["samples with flat ends", sampledCurve([0, 0, 30000, 65535, 65535])],
	["descending samples", sampledCurve([65535, 30000, 0])],
	["parametric gamma", parametricCurve(0, [2])],
	["power with flat toe", parametricCurve(1, [2, 1, -0.25])],
	["power with an offset", parametricCurve(2, [2, 1, -0.25, 0.125])],
	["continuous linear and power branches", parametricCurve(3, [2, 1, 0, 0.5, 0.5])],
	["active linear branch only", parametricCurve(3, [1, 1, 0, 0.5, 1.5])],
	["descending into a clipped plateau", parametricCurve(4, [1, 1, 0, -0.5, 0.5, -1, 0.25])],
	["one fixed-point step of range", parametricCurve(1, [1, 1 / 65536, 0])],
	["active power branch only", parametricCurve(4, [1, 1, 0, -1, 0, 0, 0.5])],
	["clipped flat ends", parametricCurve(4, [1, 2, -0.5, 1, 0.25, 0, -0.25])],
	["downward junction hidden by clipping", parametricCurve(4, [1, 1, 0, 1, 0.5, -0.75, -0.625])],
] as const;

function padding(length: number) {
	return Buffer.alloc((4 - (length % 4)) % 4);
}

export function withRedCurve(profile: Buffer, curve: Buffer) {
	const tableEnd = 132 + profile.readUInt32BE(128) * 12;
	const padded = padding(profile.length);
	for (let entry = 132; entry < tableEnd; entry += 12) {
		if (profile.toString("ascii", entry, entry + 4) !== "rTRC") continue;
		// Leave the original shared curve in place for the green and blue channels.
		const modified = Buffer.concat([profile, padded, curve, padding(curve.length)]);
		modified.writeUInt32BE(modified.length);
		modified.writeUInt32BE(profile.length + padded.length, entry + 4);
		modified.writeUInt32BE(curve.length, entry + 8);
		return modified;
	}
	throw new Error("Missing fixture red curve");
}
