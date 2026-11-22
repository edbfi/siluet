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

test("PoYo image models require image inputs when their kinds are supplied", () => {
	expect(
		estimatePrice(feed, { ...seedreamEdit, sourceKinds: ["image", "video"] }, now),
	).toMatchObject({ reason: "unsupported-input" });
	expect(estimatePrice(feed, { ...seedreamEdit, sourceKinds: undefined }, now)).toEqual(
		estimatePrice(feed, seedreamEdit, now),
	);
});

describe("confirmed PoYo v2 rates", () => {
	const day = 24 * 60 * 60 * 1000;
	const v2 = {
		...feed,
		version: 2,
		revision: "747e5d75319585d66396a3c05bd1b97d9390ce74",
		sourceDate: "2026-11-19T13:42:30Z",
		confirmedAt: "2026-12-19T05:30:00Z",
	} as const;

	test("stays known after the source ages when a later confirmation exists", () => {
		const at = Date.parse("2026-12-20T12:00:00Z");
		expect(estimatePrice({ ...v2, version: 1, confirmedAt: undefined }, zImage, at)).toMatchObject({
			status: "unknown",
		});
		expect(estimatePrice(v2, zImage, at)).toEqual({
			status: "known",
			unit: "poyo_credit",
			perRequest: "2.75",
			batch: "2.75",
			maxAttempts: 1,
			sourceDate: v2.sourceDate,
			revision: v2.revision,
			expiresAt: "2027-01-18T05:30:00.000Z",
		});
	});

	test("expires 30 days after the confirmation", () => {
		const expiresAt = Date.parse(v2.confirmedAt) + 30 * day;
		expect(estimatePrice(v2, zImage, expiresAt - 1)).toMatchObject({ status: "known" });
		expect(estimatePrice(v2, zImage, expiresAt)).toMatchObject({ reason: "expired-feed" });
	});

	test("caps a confirmation dated after the clock at 30 days from now", () => {
		const at = Date.parse("2026-12-01T00:00:00Z");
		expect(estimatePrice(v2, zImage, at)).toMatchObject({
			status: "known",
			sourceDate: v2.sourceDate,
			expiresAt: "2026-12-31T00:00:00.000Z",
		});
	});

	test("reports an invalid clock only before the source date", () => {
		const source = Date.parse(v2.sourceDate);
		expect(estimatePrice(v2, zImage, source - 1)).toMatchObject({ reason: "invalid-clock" });
		expect(estimatePrice(v2, zImage, source)).toMatchObject({ status: "known" });
	});

	test("quotes an unfamiliar or mismatched kind as unavailable", () => {
		const unfamiliar = { kind: "per-second-by-resolution", resolutions: { "480p": "10" } };
		const at = Date.parse("2026-12-01T00:00:00Z");
		for (const rates of [
			{ ...v2.rates, "z-image": unfamiliar },
			{ ...v2.rates, "z-image": v2.rates["seedream-5.5"] },
		]) {
			expect(estimatePrice({ ...v2, rates }, zImage, at)).toEqual({
				status: "unknown",
				reason: "rate-unavailable",
				maxAttempts: 1,
			});
		}
		expect(
			estimatePrice(
				{ ...v2, rates: { ...v2.rates, "seedream-5.5": v2.rates["z-image"] } },
				seedreamEdit,
				at,
			),
		).toMatchObject({ reason: "rate-unavailable" });
		expect(
			estimatePrice({ ...v2, rates: { ...v2.rates, "h3-max": unfamiliar } }, seedreamEdit, at),
		).toMatchObject({ status: "known", batch: "51" });
	});

	test("leaves v1 ageing from the source date", () => {
		expect(estimatePrice(feed, zImage, Date.parse("2026-12-19T13:27:00Z"))).toMatchObject({
			reason: "expired-feed",
		});
	});
});
