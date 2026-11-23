import { expect, test } from "bun:test";
import { profileHdr } from "./icc-profile";
import { cicpTag, gainTag, hagcType, icc, lutTag } from "./original.fixture";

test.each([
	["PQ cicp", icc([cicpTag(9, 16)])],
	["HLG cicp", icc([cicpTag(9, 18)])],
	["an ADGC tag", icc([gainTag])],
	["a hagc element", icc([hagcType])],
	["a gain curve after other tags", icc([lutTag, gainTag])],
])("profileHdr finds %s", (_label, profile) => {
	expect(profileHdr(profile)).toBe("hdr");
});

test.each([
	["a LUT profile", icc([lutTag])],
	["a color-only cicp", icc([cicpTag(12, 13)])],
	["an unknown primary cicp", icc([cicpTag(99, 13)])],
	["a truncated tag table", icc([gainTag]).subarray(0, 140)],
	["a tag past the end", Buffer.concat([icc([lutTag]).subarray(0, 132 + 12), Buffer.from("ADGC")])],
	["a short header", Buffer.alloc(100)],
	["an empty buffer", Buffer.alloc(0)],
])("profileHdr finds nothing in %s", (_label, profile) => {
	expect(profileHdr(profile)).toBeUndefined();
});

test("profileHdr bounds a claimed tag count by the profile length", () => {
	const profile = icc([gainTag]);
	profile.writeUInt32BE(0xffffffff, 128);
	expect(profileHdr(profile)).toBeUndefined();
});
