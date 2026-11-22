import { expect, test } from "bun:test";
import { byteRange } from "./range";

test("single ranges support clipped ends, open ends, suffixes and unsatisfiable positions", () => {
	for (const [raw, expected] of [
		["bytes=1-5", [1, 5]],
		["bytes=3-", [3, 9]],
		["bytes=-2", [8, 9]],
		["bytes=1-99", [1, 9]],
		["bytes=10-", "unsatisfiable"],
		["bytes=-0", "unsatisfiable"],
		["bytes=4-2", null],
		["bytes=1-2,4-5", null],
		["bad=0-3", null],
	] as const)
		expect(byteRange(raw, 10)).toEqual(expected);
});
