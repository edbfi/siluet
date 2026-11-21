import { expect, test } from "bun:test";
import { toapisRates } from "../../../../tests/fixtures/toapis-feed";
import { estimatePrice, type PriceInput } from "./estimate";
import { decodeToapisPricingFeed } from "./toapis-feed";

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
	).toMatchObject({ status: "known", perRequest: "3.2", batch: "16" });
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
				index === 2 || index === 3
					? { ...rate, source: { ...rate.source, cacheAgeSeconds: 25 } }
					: rate,
			),
		},
		{ ...toapisRates, rates: [...toapisRates.rates].reverse() },
	]) {
		expect(decodeToapisPricingFeed(invalid)).toBeUndefined();
	}
});
