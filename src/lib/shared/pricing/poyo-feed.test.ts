import { describe, expect, test } from "bun:test";
import bundledV1 from "../../../../pricing/v1/feed.json";
import bundledV2 from "../../../../pricing/v2/poyo.json";
import h3Fixture from "../../../../tests/fixtures/h3-rate.v2.json";
import { poyoV2Feed } from "../../../../tests/fixtures/poyo-v2-feed";
import { decodePricingFeed } from "./feed";
import { decodePoyoPricingFeed, decodePoyoV2Feed, poyoFeedExpiryMs } from "./poyo-feed";

const day = 24 * 60 * 60 * 1000;

function withRates(rates: Record<string, unknown>) {
	return { ...poyoV2Feed, rates: { ...poyoV2Feed.rates, ...rates } };
}

function nested(depth: number): unknown {
	return depth === 0 ? "1" : { level: nested(depth - 1) };
}

test("the bundled v2 feed confirms the bundled v1 rates", () => {
	expect<unknown>(decodePoyoV2Feed(bundledV2)).toEqual(bundledV2);
	const { confirmedAt, version, ...rest } = bundledV2;
	expect(version).toBe(2);
	expect({ ...rest, version: 1 }).toEqual(bundledV1);
	expect(Date.parse(confirmedAt)).toBeGreaterThanOrEqual(Date.parse(bundledV2.sourceDate));
});

describe("PoYo pricing v2 feed", () => {
	test("decodes the two-model feed with its confirmation", () => {
		expect(decodePoyoV2Feed(JSON.parse(JSON.stringify(poyoV2Feed)))).toEqual(poyoV2Feed);
		expect(decodePoyoPricingFeed(poyoV2Feed)).toEqual(poyoV2Feed);
		expect(decodePricingFeed(poyoV2Feed)).toBeUndefined();
	});

	test("accepts catalog model IDs with slashes and dots", () => {
		const rate = { kind: "per-request", credits: "3" };
		const decoded = decodePoyoV2Feed(withRates({ "kling-2.1/pro": rate, "kling-3.0/4K": rate }));
		expect(decoded?.rates["kling-2.1/pro"]).toEqual(rate);
		expect(decoded?.rates["kling-3.0/4K"]).toEqual(rate);
	});

	test.each(["z-image", "seedream-5.5"])("rejects a feed missing %s", (model) => {
		const rates: Record<string, unknown> = { ...poyoV2Feed.rates };
		delete rates[model];
		expect(decodePoyoV2Feed({ ...poyoV2Feed, rates })).toBeUndefined();
	});

	test("preserves an unfamiliar rate and serialises it unchanged", () => {
		const decoded = decodePoyoV2Feed(JSON.parse(JSON.stringify(h3Fixture)));
		expect<unknown>(decoded).toEqual(h3Fixture);
		expect(JSON.parse(JSON.stringify(decoded))).toEqual(h3Fixture);
		expect(Object.getPrototypeOf(decoded?.rates["h3-max"])).toBeNull();
	});

	test("accepts unfamiliar rates up to four objects deep with shared decimal bounds", () => {
		expect(decodePoyoV2Feed(withRates({ deep: { kind: "tiered", a: nested(3) } }))).toBeDefined();
		expect(
			decodePoyoV2Feed(
				withRates({ free: { kind: "per-call", base: "0", max: "999999999999.999999" } }),
			),
		).toBeDefined();
	});

	test.each([
		{ kind: "per-second", values: ["1"] },
		{ kind: "per-second", value: 1 },
		{ kind: "per-second", value: null },
		{ kind: "per-second", value: true },
		{ kind: "Per-Second", value: "1" },
		{ kind: "-second", value: "1" },
		{ kind: 1, value: "1" },
		{ value: "1" },
		{ kind: "per-second", value: "01" },
		{ kind: "per-second", value: "1.0000001" },
		{ kind: "per-second", value: "1234567890123" },
		{ kind: "per-second", "bad key": "1" },
		{ kind: "per-second", a: nested(4) },
		["per-second"],
		"per-second",
	])("rejects malformed unfamiliar rate %#", (rate) => {
		expect(decodePoyoV2Feed(withRates({ "h3-max": rate }))).toBeUndefined();
	});

	test.each([
		{ kind: "unavailable", credits: "1" },
		{ kind: "per-request", credits: "0" },
		{ kind: "per-request", credits: "2", extra: "1" },
		{ kind: "per-image-with-references", resolutions: { "1K": "1" }, perReference: "1" },
	])("rejects a malformed familiar kind at any key %#", (rate) => {
		expect(decodePoyoV2Feed(withRates({ "other-model": rate }))).toBeUndefined();
	});

	test.each([
		{ confirmedAt: undefined },
		{ confirmedAt: "2026-11-22T13:30:00.500Z" },
		{ confirmedAt: "2026-11-22T14:30:00+01:00" },
		{ confirmedAt: "2026-11-19T13:42:29Z" },
		{ confirmedAt: "2026-02-30T00:00:00Z" },
		{ version: 1 },
		{ provider: "toapis" },
		{ revision: "abc" },
		{ sourceDate: "2026-11-19" },
		{ extra: true },
	])("rejects invalid identity or confirmation %#", (change) => {
		const candidate: Record<string, unknown> = { ...poyoV2Feed, ...change };
		if ("confirmedAt" in change && change.confirmedAt === undefined) delete candidate.confirmedAt;
		expect(decodePoyoV2Feed(candidate)).toBeUndefined();
	});

	test("accepts a confirmation at the source date", () => {
		expect(decodePoyoV2Feed({ ...poyoV2Feed, confirmedAt: poyoV2Feed.sourceDate })).toBeDefined();
	});

	test("bounds the number of rates and their keys", () => {
		const rate = { kind: "unavailable" };
		const many = Object.fromEntries(Array.from({ length: 998 }, (_, index) => [`m${index}`, rate]));
		expect(decodePoyoV2Feed(withRates(many))).toBeDefined();
		expect(decodePoyoV2Feed(withRates({ ...many, extra: rate }))).toBeUndefined();
		for (const key of ["", "-lead", "a b", "a".repeat(129), "é", "_x"]) {
			expect(decodePoyoV2Feed(withRates({ [key]: rate }))).toBeUndefined();
		}
		expect(decodePoyoV2Feed(withRates({ ["a".repeat(128)]: rate }))).toBeDefined();
	});

	test("an own __proto__ key is inert", () => {
		const hostile = JSON.parse(
			`{"version":2,"provider":"poyo","revision":"${poyoV2Feed.revision}","sourceDate":"${poyoV2Feed.sourceDate}","confirmedAt":"${poyoV2Feed.confirmedAt}","rates":{"z-image":{"kind":"unavailable"},"seedream-5.5":{"kind":"unavailable"},"h3":{"kind":"x","__proto__":{"polluted":"1"}}}}`,
		);
		expect(decodePoyoV2Feed(hostile)).toBeUndefined();
		const decoded = decodePoyoV2Feed(poyoV2Feed);
		expect(Object.getPrototypeOf(decoded?.rates)).toBeNull();
		expect(decoded?.rates.constructor).toBeUndefined();
		expect(({} as Record<string, unknown>).polluted).toBeUndefined();
	});
});

describe("PoYo rate expiry", () => {
	test("ages v1 from the source and v2 from the confirmation, never beyond the clock", () => {
		const { confirmedAt: _, ...rest } = poyoV2Feed;
		const v1 = decodePricingFeed({ ...rest, version: 1 });
		if (!v1) throw new Error("Expected a v1 feed");
		expect(poyoFeedExpiryMs(v1)).toBe(Date.parse(v1.sourceDate) + 30 * day);
		const confirmed = Date.parse(poyoV2Feed.confirmedAt);
		expect(poyoFeedExpiryMs(poyoV2Feed)).toBe(confirmed + 30 * day);
		expect(poyoFeedExpiryMs(poyoV2Feed, confirmed + day)).toBe(confirmed + 30 * day);
		// A confirmation after the local clock falls back to the source date, so the expiry
		// stays fixed while the clock catches up instead of moving with every request.
		const fromSource = Date.parse(poyoV2Feed.sourceDate) + 30 * day;
		expect(poyoFeedExpiryMs(poyoV2Feed, confirmed - day)).toBe(fromSource);
		expect(poyoFeedExpiryMs(poyoV2Feed, confirmed - 1)).toBe(fromSource);
	});
});
