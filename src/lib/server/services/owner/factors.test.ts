import { expect, test } from "bun:test";
import { checkStep, makeRecoverySet, recoveryDigest } from "./factors";

const seed = Buffer.from("12345678901234567890");
test.each([
	[59, "287082"],
	[1111111109, "081804"],
	[1111111111, "050471"],
	[1234567890, "005924"],
	[2000000000, "279037"],
	[20000000000, "353130"],
] as const)("RFC 6238 SHA1 vector at %s reduced to six digits", (time, code) => {
	const step = Math.floor(time / 30);
	for (const offset of [-30000, 0, 30000])
		expect(checkStep(seed, code, time * 1000 + offset, -1)).toBe(step);
	expect(checkStep(seed, code, time * 1000, step)).toBeNull();
	expect(checkStep(seed, `${code} `, time * 1000, -1)).toBeNull();
});
test("recovery codes are set and installation specific", () => {
	const set = makeRecoverySet("installation");
	expect(set.codes.length).toBe(10);
	const value = set.codes[0];
	expect(recoveryDigest("installation", set.id, value.toLowerCase().replaceAll("-", ""))).toEqual(
		set.digests[0],
	);
	expect(recoveryDigest("other", set.id, value)).not.toEqual(set.digests[0]);
});
