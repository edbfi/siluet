import { expect, test } from "bun:test";
import { toapisRates } from "../../../../tests/fixtures/toapis-feed";
import { estimatePrice, type PriceInput } from "./estimate";
import {
	decodeToapisPricingFeed,
	toapisEffectiveObservations,
	toapisRateExpiryMs,
} from "./toapis-feed";

const now = Date.parse("2026-11-21T12:00:00Z");
const image: PriceInput = {
	provider: "toapis",
	model: "doubao-seedream-5-5",
	operation: "generate",
	options: {
		disable_nsfw: false,
		size: "2K",
		metadata: { background: "auto", output_format: "png", watermark: false },
	},
	sourceCount: 0,
	count: 5,
	retryLimit: 3,
};

test("quotes the public rate for a tier and initial batch in approximate ToAPIs credits and USD", () => {
	const feed = decodeToapisPricingFeed(toapisRates);
	expect(feed).toBeDefined();
	expect(estimatePrice(feed, image, now)).toMatchObject({
		status: "known",
		unit: "toapis_credit",
		perRequest: "5.6",
		batch: "28",
		usd: { perRequest: "0.028", batch: "0.14" },
		maxAttempts: 20,
		sourceDate: toapisRates.observedAt,
		source: { scope: "public-advertised", publishedAt: null },
	});
	expect(
		estimatePrice(
			feed,
			{ ...image, operation: "edit", sourceCount: 10, options: { size: "1.5K" } },
			now,
		),
	).toMatchObject({
		status: "known",
		perRequest: "16",
		batch: "80",
		usd: { perRequest: "0.08", batch: "0.4" },
		referenceImages: { count: 10, usdEach: "0.0064", approximateCreditsEach: "1.28" },
	});
});

test.each([
	["2K", 0, "5.6", "0.028"],
	["2K", 1, "6.88", "0.0344"],
	["2K", 2, "8.16", "0.0408"],
	["2K", 10, "18.4", "0.092"],
	// A billed 1K edit with one reference settled at 4.48 credits ($0.0224), input_images: 1.
	["1K", 1, "4.48", "0.0224"],
] as const)(
	"quotes a %s request with %i references as the tier plus each reference",
	(size, references, credits, usd) => {
		const input = {
			...image,
			count: 1,
			operation: references ? "edit" : "generate",
			sourceCount: references,
			options: { ...image.options, size },
		};
		const quote = estimatePrice(decodeToapisPricingFeed(toapisRates), input, now);
		expect(quote).toMatchObject({
			status: "known",
			perRequest: credits,
			batch: credits,
			usd: { perRequest: usd, batch: usd },
		});
		if (references) {
			expect(quote).toMatchObject({
				referenceImages: { count: references, usdEach: "0.0064", approximateCreditsEach: "1.28" },
			});
		} else {
			expect(quote).not.toHaveProperty("referenceImages");
		}
	},
);

test("an edit expires with the older of its tier and reference evidence", () => {
	const feed = decodeToapisPricingFeed({
		...toapisRates,
		rates: toapisRates.rates.map((rate) =>
			rate.model === "doubao-seedream-5-5"
				? { ...rate, source: { ...rate.source, cacheAgeSeconds: 120 } }
				: rate,
		),
	});
	const edit = { ...image, operation: "edit", sourceCount: 2 };
	const expiry = Date.parse(toapisRates.observedAt) + 30 * 86400_000 - 120_000;
	expect(estimatePrice(feed, edit, expiry - 1)).toMatchObject({
		status: "known",
		expiresAt: new Date(expiry).toISOString(),
	});
	expect(estimatePrice(feed, edit, expiry)).toMatchObject({
		status: "unknown",
		reason: "expired-feed",
	});
});

test.each([
	{},
	{ size: "2048x2048" },
	{ size: "2K", n: 2 },
	{ size: "2K", metadata: { layer_decomposition: true } },
	{ size: "2K", metadata: { background: "transparent", output_format: "jpeg" } },
	{ size: "2K", metadata: { watermark: true } },
	{ size: "2K", resolution: "1K" },
	{ size: "2K", unknown: true },
])("keeps an uncovered image request unknown %#", (options) => {
	expect(estimatePrice(decodeToapisPricingFeed(toapisRates), { ...image, options }, now)).toEqual({
		status: "unknown",
		reason: "unsupported-input",
		maxAttempts: 20,
	});
});

test.each([
	["generate", [], "10"],
	["generate", ["image"], "10"],
	["animate", ["image"], "10"],
	["interpolate", ["image", "image"], "10"],
	["generate", ["image", "audio"], "10"],
	["generate", ["image", "video", "audio"], "6"],
	["edit", ["video"], "6"],
	["generate", ["video", "unknown"], "6"],
] as const)("uses the actual input media for Seedance %s %j", (operation, sourceKinds, usd) => {
	const input = {
		...image,
		model: "seedance-2-5",
		options: {},
		operation,
		sourceKinds,
		sourceCount: sourceKinds.length,
	};
	expect(estimatePrice(toapisRates, input, now)).toMatchObject({
		status: "unknown",
		reason: "token-usage-unknown",
		advertisedUnitRate: { unit: "million-total-tokens", usd },
	});
});

test.each([
	{ operation: "edit", sourceCount: 1 },
	{ operation: "generate", sourceCount: 1, sourceKinds: ["unknown"] },
	{ operation: "edit", sourceCount: 1, sourceKinds: ["image"] },
	{ operation: "generate", sourceCount: 2, sourceKinds: ["video"] },
] as const)("leaves the unit rate unknown for ambiguous or invalid Seedance media %#", (media) => {
	const input = { ...image, model: "seedance-2-5", options: {}, ...media };
	expect(estimatePrice(toapisRates, input, now)).toEqual({
		status: "unknown",
		reason: "unsupported-input",
		maxAttempts: 20,
	});
});

test("rejects wrong conversion, duplicate rate conditions and private source metadata", () => {
	const [rate, ...remaining] = toapisRates.rates;
	for (const invalid of [
		{ ...rate, approximateCredits: "5" },
		{ ...rate, ...remaining[0] },
		{ ...rate, source: { ...rate.source, scope: "account" } },
	]) {
		expect(
			decodeToapisPricingFeed({ ...toapisRates, rates: [invalid, ...remaining] }),
		).toBeUndefined();
	}
});

test("uses the older model or conversion evidence for expiry", () => {
	const feed = decodeToapisPricingFeed({ ...toapisRates, conversionCacheAgeSeconds: 60 });
	const expiry = Date.parse(toapisRates.observedAt) + 30 * 86400_000 - 60_000;
	expect(estimatePrice(feed, image, expiry - 1)).toMatchObject({ status: "known" });
	expect(estimatePrice(feed, image, expiry)).toMatchObject({
		status: "unknown",
		reason: "expired-feed",
	});
	expect(estimatePrice(feed, image, Date.parse(toapisRates.observedAt) - 1)).toMatchObject({
		reason: "invalid-clock",
	});
});

test("covers the advertised 2K transparent PNG example", () => {
	const feed = decodeToapisPricingFeed(toapisRates);
	const options = { size: "2K", metadata: { background: "transparent", output_format: "png" } };
	expect(estimatePrice(feed, { ...image, options }, now)).toMatchObject({
		status: "known",
		perRequest: "5.6",
	});
});

test("rejects inconsistent paired rates and per-model age plus noncanonical observations", () => {
	for (const invalid of [
		{ ...toapisRates, observedAt: "2026-11-20T12:00:00.125Z" },
		{ ...toapisRates, observedAt: "2026-11-20T12:00:00+00:00" },
		{
			...toapisRates,
			rates: toapisRates.rates.map((rate, index) =>
				index === 1 ? { ...rate, usd: "0.017", approximateCredits: "3.4" } : rate,
			),
		},
		{
			...toapisRates,
			rates: toapisRates.rates.map((rate, index) =>
				index === 2 || index === 4
					? { ...rate, source: { ...rate.source, cacheAgeSeconds: 25 } }
					: rate,
			),
		},
		{ ...toapisRates, rates: [...toapisRates.rates].reverse() },
	]) {
		expect(decodeToapisPricingFeed(invalid)).toBeUndefined();
	}
});

test("receipt delays and reported cache ages both count toward rate expiry", () => {
	const feed = decodeToapisPricingFeed({
		...toapisRates,
		conversionCacheAgeSeconds: null,
		receiptDelaySeconds: { conversion: 4, image: 2, video: 0 },
		rates: toapisRates.rates.map((rate) => ({
			...rate,
			source: {
				...rate.source,
				cacheAgeSeconds: rate.model === "doubao-seedream-5-5" ? 9 : null,
			},
		})),
	});
	if (!feed) throw new Error("Valid staggered feed was rejected.");
	const observed = Date.parse(feed.observedAt);
	expect(toapisEffectiveObservations(feed).map((value) => (observed - value) / 1000)).toEqual([
		4, 11, 11, 11, 11, 0, 0,
	]);
	const expiry = observed + 30 * 86400 * 1000;
	expect(toapisRateExpiryMs(feed, feed.rates[0])).toBe(expiry - 11000);
	expect(toapisRateExpiryMs(feed, feed.rates[4])).toBe(expiry - 4000);
});

test("the reference-image rate ages with the Seedream page, not the Seedance page", () => {
	const feed = decodeToapisPricingFeed({
		...toapisRates,
		receiptDelaySeconds: { conversion: 3, image: 2, video: 0 },
	});
	if (!feed) throw new Error("Valid staggered feed was rejected.");
	const observed = Date.parse(feed.observedAt);
	const reference = feed.rates.find((rate) => rate.unit === "reference-image");
	if (!reference) throw new Error("Missing reference-image rate.");
	expect(toapisEffectiveObservations(feed).map((value) => (observed - value) / 1000)).toEqual([
		3, 2, 2, 2, 2, 0, 0,
	]);
	expect(toapisRateExpiryMs(feed, reference)).toBe(observed + 30 * 86400 * 1000 - 3000);
});

test("decodes the v2 feed with one flat reference-image rate and no free allowance", () => {
	const feed = decodeToapisPricingFeed(toapisRates);
	expect(feed?.version).toBe(2);
	expect(feed?.rates[3]).toMatchObject({
		model: "doubao-seedream-5-5",
		operations: ["generate", "edit"],
		unit: "reference-image",
		conditions: { freeAllowance: 0 },
		usd: "0.0064",
		approximateCredits: "1.28",
		source: toapisRates.rates[0].source,
	});
});

test.each([
	["a nonzero free allowance", { conditions: { freeAllowance: 1 } }],
	["an extra condition", { conditions: { freeAllowance: 0, size: "1K" } }],
	["an extra rate key", { note: "per image" }],
	["a zero amount", { usd: "0", approximateCredits: "0" }],
	["the wrong conversion", { approximateCredits: "1.3" }],
	["another model", { model: "seedance-2-5", source: toapisRates.rates[5].source }],
	[
		"a source cache age that differs from the tiers",
		{ source: { ...toapisRates.rates[3].source, cacheAgeSeconds: 5 } },
	],
])("rejects a reference-image rate with %s", (_reason, change) => {
	const rates = toapisRates.rates.map((rate, index) =>
		index === 3 ? { ...rate, ...change } : rate,
	);
	expect(decodeToapisPricingFeed({ ...toapisRates, rates })).toBeUndefined();
});

test("rejects the frozen v1 feed and v1 data labelled as v2", () => {
	const { receiptDelaySeconds: _delays, ...fields } = toapisRates;
	const rates = toapisRates.rates.filter((rate) => rate.unit !== "reference-image");
	for (const invalid of [
		{ ...fields, version: 1, rates },
		{ ...toapisRates, version: 1, rates },
		{ ...toapisRates, version: 1 },
		{ ...toapisRates, rates },
	]) {
		expect(decodeToapisPricingFeed(invalid)).toBeUndefined();
	}
});

test("rejects a v2 feed without the reference rate, out of order, or without receipt delays", () => {
	const { receiptDelaySeconds: _delays, ...withoutDelays } = toapisRates;
	const [one, oneAndHalf, two, reference, ...video] = toapisRates.rates;
	for (const invalid of [
		{ ...toapisRates, rates: [one, oneAndHalf, two, ...video] },
		{ ...toapisRates, rates: [reference, one, oneAndHalf, two, ...video] },
		{ ...toapisRates, rates: [one, oneAndHalf, two, ...video, reference] },
		{ ...toapisRates, rates: [one, oneAndHalf, two, reference, reference, ...video] },
		withoutDelays,
		{ ...toapisRates, version: 3 },
	]) {
		expect(decodeToapisPricingFeed(invalid)).toBeUndefined();
	}
});
