import { expect, test } from "bun:test";
import { creditUnits, formatCredits } from "./decimal";

test("rejects overprecision and negative input and formats signed unit differences", () => {
	expect(() => creditUnits("0.0000001")).toThrow(RangeError);
	expect(() => creditUnits("-1.5")).toThrow(RangeError);
	expect(formatCredits(-1n)).toBe("-0.000001");
	expect(formatCredits(-1_500_000n)).toBe("-1.5");
});
