import { describe, expect, test } from "bun:test";
import { estimatePrice, type PriceInput } from "./estimate";
import type { PricingFeed } from "./feed";

const feed: PricingFeed = {
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
};

const now = Date.parse("2026-11-21T15:00:00Z");
const zImage: PriceInput = {
	provider: "poyo",
	model: "z-image",
	operation: "generate",
	options: { size: "4:3", enable_safety_checker: false },
	sourceCount: 0,
	count: 1,
	retryLimit: 0,
};
const seedreamEdit: PriceInput = {
	...zImage,
	model: "seedream-5.5",
	operation: "edit",
	options: {
		resolution: "2K",
		enable_safety_checker: false,
		background: "auto",
		output_format: "png",
	},
	sourceCount: 2,
	count: 5,
	retryLimit: 3,
};

describe("local price estimates", () => {
	test("estimates a fixed request and keeps retry exposure in attempts", () => {
		expect(estimatePrice(feed, { ...zImage, count: 3, retryLimit: 1 }, now)).toEqual({
			status: "known",
			unit: "poyo_credit",
			perRequest: "2.75",
			batch: "8.25",
			maxAttempts: 6,
			sourceDate: feed.sourceDate,
			revision: feed.revision,
			expiresAt: "2026-12-19T13:27:00.000Z",
		});
		expect(
			estimatePrice(feed, { ...zImage, operation: "edit", sourceCount: 1, options: {} }, now),
		).toMatchObject({ status: "known", perRequest: "2.75" });
	});

	test("adds references with exact decimal arithmetic before multiplying the batch", () => {
		expect(estimatePrice(feed, seedreamEdit, now)).toMatchObject({
			status: "known",
			perRequest: "10.2",
			batch: "51",
			maxAttempts: 20,
		});
		expect(
			estimatePrice(
				feed,
				{ ...seedreamEdit, operation: "generate", sourceCount: 0, options: {} },
				now,
			),
		).toMatchObject({ status: "known", perRequest: "7", batch: "35" });
		expect(
			estimatePrice(
				feed,
				{ ...seedreamEdit, sourceCount: 10, options: { size: "auto", resolution: "1.5K" } },
				now,
			),
		).toMatchObject({ status: "known", perRequest: "20", batch: "100" });
	});

	test("supports the highest feed precision without rounding", () => {
		const rates: PricingFeed["rates"] = {
			...feed.rates,
			"seedream-5.5": {
				kind: "per-image-with-references",
				resolutions: { "1K": "1", "1.5K": "2", "2K": "999999999999.999999" },
				perReference: "0.000001",
			},
		};
		expect(estimatePrice({ ...feed, rates }, seedreamEdit, now)).toMatchObject({
			status: "known",
			perRequest: "1000000000000.000001",
			batch: "5000000000000.000005",
		});
	});

	test.each([
		{ ...zImage, options: {} },
		{ ...zImage, options: { size: "auto" } },
		{ ...zImage, sourceCount: 1 },
		{ ...zImage, count: 6 },
		{ ...zImage, count: 1.5 },
		{ ...zImage, retryLimit: 4 },
		{ ...zImage, retryLimit: -1 },
		{ ...zImage, operation: "edit", sourceCount: 2 },
		{ ...zImage, operation: "image-to-image" },
		{ ...zImage, outputCount: 2 },
		{ ...seedreamEdit, options: { resolution: "4K" } },
		{ ...seedreamEdit, options: { resolution: "2K", n: 2 } },
		{
			...seedreamEdit,
			options: { resolution: "2K", background: "transparent", output_format: "jpeg" },
		},
		{ ...seedreamEdit, options: { resolution: "2K", enable_safety_checker: "false" } },
		{ ...seedreamEdit, options: { image_urls: ["https://example.test/image.png"] } },
		{ ...seedreamEdit, sourceCount: 0 },
		{ ...seedreamEdit, sourceCount: 11 },
	])("rejects unsupported modes, fields and counts %#", (input) => {
		expect(estimatePrice(feed, input, now)).toMatchObject({
			status: "unknown",
			reason: "unsupported-input",
		});
	});

	test("preserves the valid batch attempt bound when pricing is unknown", () => {
		expect(estimatePrice(feed, { ...seedreamEdit, provider: "toapis" }, now)).toEqual({
			status: "unknown",
			reason: "unsupported-provider",
			maxAttempts: 20,
		});
		expect(estimatePrice(feed, { ...seedreamEdit, model: "seedream-5.5-layerize" }, now)).toEqual({
			status: "unknown",
			reason: "unsupported-model",
			maxAttempts: 20,
		});
		expect(estimatePrice(feed, { ...seedreamEdit, count: Number.NaN }, now)).toMatchObject({
			maxAttempts: null,
		});
		expect(estimatePrice(undefined, seedreamEdit, now)).toMatchObject({ reason: "missing-feed" });
		expect(estimatePrice(undefined, seedreamEdit, Number.NaN)).toMatchObject({
			reason: "invalid-clock",
		});
	});

	test("expires at 30 days and rejects invalid or pre-source clocks", () => {
		const expiresAt = Date.parse("2026-12-19T13:27:00Z");
		expect(estimatePrice(feed, zImage, expiresAt - 1)).toMatchObject({ status: "known" });
		expect(estimatePrice(feed, zImage, expiresAt)).toMatchObject({ reason: "expired-feed" });
		expect(estimatePrice(feed, zImage, Date.parse(feed.sourceDate) - 1)).toMatchObject({
			reason: "invalid-clock",
		});
		expect(estimatePrice(feed, zImage, Number.POSITIVE_INFINITY)).toMatchObject({
			reason: "invalid-clock",
		});
	});

	test("an unavailable rate affects only its own model", () => {
		const rates: PricingFeed["rates"] = { ...feed.rates, "z-image": { kind: "unavailable" } };
		const updated = { ...feed, rates };
		expect(estimatePrice(updated, zImage, now)).toEqual({
			status: "unknown",
			reason: "rate-unavailable",
			maxAttempts: 1,
		});
		expect(estimatePrice(updated, seedreamEdit, now)).toMatchObject({
			status: "known",
			batch: "51",
		});
	});
});

test("unvalidated pricing input fails closed", () => {
	for (const invalid of [
		{ ...feed, sourceDate: "not a date" },
		{ ...feed, rates: {} },
		{ ...feed, rates: { ...feed.rates, "z-image": { kind: "per-request", credits: "2.0000001" } } },
	]) {
		expect(estimatePrice(invalid, zImage, now)).toMatchObject({ status: "unknown" });
	}
});
