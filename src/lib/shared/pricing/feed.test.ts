import { describe, expect, test } from "bun:test";
import { toapisRates } from "../../../../tests/fixtures/toapis-feed";
import { decodePricingFeed, type PricingFeed } from "./feed";
import { decodePricingFeeds } from "./feeds";
import { decodeToapisPricingFeed } from "./toapis-feed";

const feed = {
	version: 1,
	provider: "poyo",
	revision: "a".repeat(40),
	sourceDate: "2026-11-19T13:27:00Z",
	rates: {
		"z-image": { kind: "per-request", credits: "2.75" },
		"seedream-5.5": {
			kind: "per-image-with-references",
			resolutions: { "1K": "4", "1.5K": "4", "2K": "7" },
			perReference: "1.6",
		},
	},
} satisfies PricingFeed;

describe("PoYo pricing v1 feed", () => {
	test("decodes a complete feed with decimal strings", () => {
		expect(decodePricingFeed(JSON.parse(JSON.stringify(feed)))).toEqual(feed);
		expect(
			decodePricingFeed({ ...feed, sourceDate: "2026-11-19T14:27:00.123+01:00" }),
		).toBeDefined();
	});

	test.each([
		null,
		[[]],
		{ ...feed, version: 2 },
		{ ...feed, provider: "toapis" },
		{ ...feed, revision: "abc" },
		{ ...feed, sourceDate: "2026-11-19" },
		{ ...feed, sourceDate: "2026-11-19T13:27:00" },
		{ ...feed, sourceDate: "2026-02-30T13:27:00Z" },
		{ ...feed, sourceDate: "2026-11-19T24:00:00Z" },
		{ ...feed, checkedAt: "2026-11-21T00:00:00Z" },
		{ ...feed, rates: { "z-image": feed.rates["z-image"] } },
		{ ...feed, rates: { ...feed.rates, "another-model": feed.rates["z-image"] } },
	])("rejects invalid version, identity, dates and incomplete coverage %#", (invalid) => {
		expect(decodePricingFeed(invalid)).toBeUndefined();
	});

	test.each([2, "0", "0.00", "-1", "1e-3", "01", " 2", "NaN", "1.0000001", "1234567890123"])(
		"rejects invalid or oversized decimal %#",
		(credits) => {
			expect(
				decodePricingFeed({
					...feed,
					rates: { ...feed.rates, "z-image": { kind: "per-request", credits } },
				}),
			).toBeUndefined();
		},
	);

	test("preserves an explicitly unavailable model alongside a reviewed rate", () => {
		const unavailable = {
			...feed,
			rates: { ...feed.rates, "z-image": { kind: "unavailable" } },
		} satisfies PricingFeed;
		expect(decodePricingFeed(unavailable)).toEqual(unavailable);
		expect(
			decodePricingFeed({
				...unavailable,
				rates: {
					...unavailable.rates,
					"z-image": { kind: "unavailable", credits: "0" },
				},
			}),
		).toBeUndefined();
	});

	test("rejects drift in rule semantics and tier coverage", () => {
		const seedream = feed.rates["seedream-5.5"];
		for (const rule of [
			{ ...seedream, kind: "formula", formula: "1+1" },
			{ ...seedream, resolutions: { "1K": "4", "2K": "7" } },
			{ ...seedream, resolutions: { ...seedream.resolutions, "4K": "11" } },
			{ ...seedream, perReference: false },
		]) {
			expect(
				decodePricingFeed({ ...feed, rates: { ...feed.rates, "seedream-5.5": rule } }),
			).toBeUndefined();
		}
	});
});

test("loads a single Studio feed or a pair without dropping the valid sibling", () => {
	const toapis = decodeToapisPricingFeed(toapisRates);
	if (!toapis) throw new Error("Invalid ToAPIs test fixture");
	expect(decodePricingFeeds(feed)).toEqual({ poyo: feed });
	expect(decodePricingFeeds(toapisRates)).toEqual({ toapis });
	expect(decodePricingFeeds({ poyo: feed, toapis: toapisRates })).toEqual({ poyo: feed, toapis });
	expect(decodePricingFeeds({ poyo: {}, toapis: toapisRates })).toEqual({
		poyo: undefined,
		toapis,
	});
	expect(decodePricingFeeds(null)).toEqual({});
});
