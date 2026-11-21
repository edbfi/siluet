import { describe, expect, test } from "bun:test";
import { reconcileWallet } from "./wallet";

const scope = { provider: "poyo", account: "demo-wallet", unit: "credits" };
const before = { ...scope, amount: "2480", observedAt: 100 };
const after = { ...scope, amount: "2476.8", observedAt: 200 };
const interval = { scope, before, after, startedAt: 100, finishedAt: 200, overlaps: false };

describe("account wallet reconciliation", () => {
	test.each([
		["2480", "2476.8", "-3.2"],
		["0", "0.10", "0.1"],
		["0.000", "0", "0"],
		["24.8001", "24.8000", "-0.0001"],
		["999999999999999999.012345678901", "999999999999999999.0123456789", "-0.000000000001"],
	])("compares decimal balances %s and %s exactly", (start, end, delta) => {
		expect(
			reconcileWallet({
				...interval,
				before: { ...before, amount: start },
				after: { ...after, amount: end },
			}),
		).toEqual({
			status: "observed",
			delta,
			unit: "credits",
			before: { ...before, amount: start },
			after: { ...after, amount: end },
		});
	});

	test.each([[{ provider: "toapis" }], [{ account: "other-wallet" }], [{ unit: "USD" }]])(
		"rejects a mismatched provider, account or unit (%j)",
		(change) => {
			expect(reconcileWallet({ ...interval, after: { ...after, ...change } })).toEqual({
				status: "unavailable",
				reason: "scope-mismatch",
			});
		},
	);

	test("rejects matching snapshots for a different account than the interval", () => {
		expect(reconcileWallet({ ...interval, scope: { ...scope, account: "other" } })).toEqual({
			status: "unavailable",
			reason: "scope-mismatch",
		});
	});

	test("overlapping local batches do not produce a comparable delta", () => {
		expect(reconcileWallet({ ...interval, overlaps: true })).toEqual({
			status: "unavailable",
			reason: "overlap",
		});
	});

	test.each([{ before: null }, { after: null }])("requires two successful reads (%j)", (change) => {
		expect(reconcileWallet({ ...interval, ...change })).toEqual({
			status: "unavailable",
			reason: "missing",
		});
	});

	test.each([
		{ before: { ...before, observedAt: 101 } },
		{ after: { ...after, observedAt: 199 } },
		{ before: { ...before, observedAt: 200 }, startedAt: 200 },
		{ startedAt: 201 },
	])("requires ordered reads bracketing the batch (%j)", (change) => {
		expect(reconcileWallet({ ...interval, ...change })).toEqual({
			status: "unavailable",
			reason: "invalid-time",
		});
	});

	test.each(["-1", "1e1", "01", "NaN", "1.0000000000000000000000001", "1\n"])(
		"rejects an invalid balance (%s)",
		(amount) => {
			expect(reconcileWallet({ ...interval, before: { ...before, amount } })).toEqual({
				status: "unavailable",
				reason: "invalid-reading",
			});
		},
	);
});
