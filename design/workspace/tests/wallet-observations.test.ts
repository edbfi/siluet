import { describe, expect, test } from "bun:test";
import { createWalletObservations } from "../wallet-observations";

const now = Date.UTC(2026, 10, 21, 12);
const seeds = {
	poyo: { value: 2480, asOf: now - 1000 },
	toapis: { value: 24.8, asOf: now - 1000 },
};
const fixture = { id: "first", batchId: "first", provider: "poyo" };
const first = {
	...fixture,
	model: "z-image",
	operation: "generate",
	status: "completed",
	attempt: 1,
	createdAt: now,
	sourceIds: [],
	options: { size: "1:1" },
	estimate: { status: "known", unit: "poyo_credit" },
};
const later = { ...first, id: "later", batchId: "later", createdAt: now + 3000 };

function create(saved?: unknown) {
	return createWalletObservations(saved, seeds, () => true);
}

function complete(wallets: ReturnType<typeof create>, id: string, start: number) {
	wallets.start("poyo", id, start);
	wallets.finish("poyo", id, start + 1000, false);
}

describe("offline wallet observations", () => {
	test("successful demo reads are coalesced per provider and batch, with immutable boundaries", () => {
		const wallets = create();
		wallets.start("poyo", "first", now);
		wallets.start("poyo", "first", now + 1);
		wallets.start("toapis", "independent", now + 2);
		wallets.finish("poyo", "first", now + 1000, false);
		wallets.finish("poyo", "first", now + 1500, false);
		wallets.finish("toapis", "independent", now + 1500, false);

		expect(wallets.comparison(first)).toMatchObject({
			status: "observed",
			delta: "-3.2",
			before: { observedAt: now, amount: "2480" },
			after: { observedAt: now + 1000, amount: "2476.8" },
		});
		expect(
			wallets.comparison({ ...first, batchId: "independent", provider: "toapis" }),
		).toMatchObject({
			status: "observed",
			delta: "-0.07",
			unit: "USD",
		});
		expect(wallets.balance("poyo")).toEqual({ value: 2476.8, unit: "credits", asOf: now + 1000 });
		const reopened = create(JSON.parse(JSON.stringify(wallets.snapshot())));
		expect(reopened.comparison(first)).toEqual(wallets.comparison(first));
		expect(reopened.balance("poyo")).toEqual(wallets.balance("poyo"));
	});

	test("a wallet Retry-After stays provider scoped and skips boundary reads during cooldown", () => {
		let wallets = create();
		complete(wallets, "first", now);
		complete(wallets, "second", now + 2000);
		wallets.start("poyo", "throttled", now + 4000);
		wallets.finish("poyo", "throttled", now + 5000, false);
		wallets = create(JSON.parse(JSON.stringify(wallets.snapshot())));

		wallets.start("poyo", "still-cooling", now + 5000);
		wallets.start("toapis", "independent", now + 5000);
		wallets.finish("toapis", "independent", now + 6000, false);
		wallets.finish("poyo", "still-cooling", now + 6000, false);
		expect(wallets.comparison({ ...first, batchId: "throttled" })).toEqual({
			status: "unavailable",
			reason: "cooldown",
		});
		expect(wallets.comparison({ ...first, batchId: "still-cooling" })).toEqual({
			status: "unavailable",
			reason: "cooldown",
		});
		expect(wallets.balance("poyo")).toMatchObject({ value: 2475.1, asOf: now + 3000 });
		expect(wallets.balance("toapis")).toMatchObject({ value: 24.73, asOf: now + 6000 });

		complete(wallets, "after-cooldown", now + 7000);
		expect(wallets.comparison({ ...first, batchId: "after-cooldown" })).toMatchObject({
			status: "observed",
			delta: "25.9",
		});
		expect(wallets.balance("poyo")).toMatchObject({ value: 2501, asOf: now + 8000 });
		complete(wallets, "other-client", now + 9000);
		complete(wallets, "failed-read", now + 11000);
		expect(wallets.comparison({ ...first, batchId: "failed-read" })).toEqual({
			status: "unavailable",
			reason: "failed",
		});
	});

	test("an interrupted, revoked or uncertain window is never repaired with a later snapshot", () => {
		let wallets = create();
		wallets.start("poyo", "first", now);
		wallets = create(JSON.parse(JSON.stringify(wallets.snapshot())));
		wallets.start("poyo", "first", now + 1500);
		wallets.finish("poyo", "first", now + 2500, false);
		expect(wallets.comparison(first)).toEqual({ status: "unavailable", reason: "interrupted" });

		wallets.start("poyo", "revoked", now + 3000);
		wallets.revoke("poyo");
		wallets.finish("poyo", "revoked", now + 4000, false);
		expect(wallets.comparison({ ...first, batchId: "revoked" })).toEqual({
			status: "unavailable",
			reason: "access",
		});
		wallets.start("poyo", "uncertain", now + 4500);
		wallets.finish("poyo", "uncertain", now + 5500, true);
		expect(wallets.comparison({ ...first, batchId: "uncertain" })).toEqual({
			status: "unavailable",
			reason: "uncertain",
		});
	});

	test("historical context requires a recent, solitary, matching, completed debit", () => {
		const wallets = create();
		complete(wallets, first.batchId, now);
		expect(wallets.history(later, [first, later], now + 4000)).toEqual({
			delta: "-3.2",
			unit: "credits",
			observedAt: now + 1000,
			sampleCount: 1,
		});
		expect(
			wallets.history({ ...later, estimate: { status: "unknown" } }, [first], now + 4000),
		).toMatchObject({ delta: "-3.2", sampleCount: 1 });
		for (const different of [
			{ provider: "toapis" },
			{ model: "seedream-5.5" },
			{ options: { size: "3:4" } },
			{ operation: "edit" },
			{ sourceIds: ["another-source"] },
			{ createdAt: now + 500 },
		]) {
			expect(wallets.history({ ...later, ...different }, [first], now + 4000)).toBeNull();
		}
		expect(wallets.history(later, [first], now + 8 * 86400000)).toBeNull();
		expect(wallets.history(later, [{ ...first, status: "failed" }], now + 4000)).toBeNull();
		expect(
			wallets.history(later, [first, { ...first, id: "retry", attempt: 2 }], now + 4000),
		).toBeNull();
		expect(
			wallets.history(
				later,
				[first, { ...first, id: "uncertain", batchId: "unknown", status: "uncertain" }],
				now + 4000,
			),
		).toBeNull();
	});

	test("a reservation or top-up sequence does not become a historical sample", () => {
		const wallets = create();
		complete(wallets, "first", now);
		complete(wallets, "second", now + 2000);
		complete(wallets, "cooldown", now + 4000);
		complete(wallets, "topup", now + 7000);
		complete(wallets, "other-client", now + 9000);
		const future = { ...later, createdAt: now + 12000 };
		const topup = { ...first, id: "topup", batchId: "topup" };
		const otherClient = { ...first, id: "other-client", batchId: "other-client" };
		expect(wallets.comparison(topup)).toMatchObject({ status: "observed", delta: "25.9" });
		expect(wallets.comparison(otherClient)).toMatchObject({ status: "observed", delta: "-2" });
		expect(wallets.history(future, [topup, otherClient], now + 13000)).toBeNull();

		const toapis = { ...first, provider: "toapis", estimate: { status: "known", unit: "USD" } };
		wallets.start("toapis", "first", now);
		wallets.finish("toapis", "first", now + 1000, false);
		expect(wallets.history({ ...later, provider: "toapis" }, [toapis], now + 4000)).toBeNull();
	});
});
