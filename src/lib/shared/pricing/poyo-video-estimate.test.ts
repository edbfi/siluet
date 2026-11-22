import { describe, expect, test } from "bun:test";
import h3Feed from "../../../../tests/fixtures/h3-rate.v2.json";
import { poyoV1Feed } from "../../../../tests/fixtures/poyo-v2-feed";
import { estimatePrice, type PriceInput } from "./estimate";

const at = Date.parse("2026-11-25T00:00:00Z");
const options = {
	duration: 5,
	resolution: "768p",
	aspect_ratio: "16:9",
	enable_safety_checker: false,
};
const input: PriceInput = {
	provider: "poyo",
	model: "h3-max",
	operation: "generate",
	options,
	sourceCount: 0,
	count: 1,
	retryLimit: 0,
};
const withOptions = (change: Record<string, unknown>) => ({
	...input,
	options: { ...options, ...change },
});

test("5 s/768p = 80", () => {
	expect(estimatePrice(h3Feed, input, at)).toEqual({
		status: "known",
		unit: "poyo_credit",
		perRequest: "80",
		batch: "80",
		maxAttempts: 1,
		sourceDate: h3Feed.sourceDate,
		revision: h3Feed.revision,
		expiresAt: "2026-12-22T13:30:00.000Z",
	});
});

test.each([
	[5, "480p", "50"],
	[10, "480p", "100"],
	[10, "768p", "160"],
	[7, "768p", "112"],
])("%i s at %s = %s credits", (duration, resolution, credits) => {
	expect(estimatePrice(h3Feed, withOptions({ duration, resolution }), at)).toMatchObject({
		status: "known",
		perRequest: credits,
	});
});

describe("inputs are checked before the clock and the feed", () => {
	test.each([
		{ sourceCount: 1, sourceKinds: ["image"] },
		{ sourceCount: 1 },
		{ operation: "edit" },
		{ count: 2 },
		{ retryLimit: 1 },
		withOptions({ duration: 4 }),
		withOptions({ duration: 11 }),
		withOptions({ duration: "5" }),
		withOptions({ resolution: "1080p" }),
		withOptions({ aspect_ratio: "adaptive" }),
		withOptions({ enable_safety_checker: true }),
		withOptions({ generate_audio: true }),
		{ options: { duration: 5, resolution: "768p" } },
	])("unsupported input %#", (change) => {
		const request = { ...input, ...change } as PriceInput;
		for (const [feed, time] of [
			[h3Feed, at],
			[undefined, at],
			[h3Feed, Number.NaN],
		] as const)
			expect(estimatePrice(feed, request, time)).toMatchObject({
				status: "unknown",
				reason: "unsupported-input",
			});
	});
});

test("an unknown total when the feed is missing, v1-only, expired or lacks the rate", () => {
	expect(estimatePrice(undefined, input, at)).toMatchObject({ reason: "missing-feed" });
	expect(estimatePrice({ version: 2 }, input, at)).toMatchObject({ reason: "missing-feed" });
	expect(estimatePrice(poyoV1Feed, input, at)).toMatchObject({ reason: "unsupported-model" });
	expect(estimatePrice(h3Feed, input, Number.NaN)).toMatchObject({ reason: "invalid-clock" });
	expect(estimatePrice(h3Feed, input, Date.parse(h3Feed.sourceDate) - 1)).toMatchObject({
		reason: "invalid-clock",
	});
	expect(estimatePrice(h3Feed, input, Date.parse("2026-12-22T13:30:00Z"))).toMatchObject({
		reason: "expired-feed",
	});
	// A newer revision without the entry has no older fallback.
	const { "h3-max": _, ...withoutH3 } = h3Feed.rates;
	expect(estimatePrice({ ...h3Feed, rates: withoutH3 }, input, at)).toMatchObject({
		reason: "rate-unavailable",
	});
	expect(
		estimatePrice(
			{ ...h3Feed, rates: { ...withoutH3, "h3-max": { kind: "unavailable" } } },
			input,
			at,
		),
	).toMatchObject({ reason: "rate-unavailable" });
	expect(
		estimatePrice(
			{ ...h3Feed, rates: { ...withoutH3, "h3-max": { kind: "per-request", credits: "80" } } },
			input,
			at,
		),
	).toMatchObject({ reason: "rate-unavailable" });
	const only480 = {
		...h3Feed,
		rates: {
			...withoutH3,
			"h3-max": { kind: "per-second-by-resolution", resolutions: { "480p": "10" } },
		},
	};
	expect(estimatePrice(only480, input, at)).toMatchObject({ reason: "unsupported-input" });
	expect(estimatePrice(only480, withOptions({ resolution: "480p" }), at)).toMatchObject({
		status: "known",
		perRequest: "50",
	});
});

test("an unknown sibling kind leaves h3-max known", () => {
	const feed = {
		...h3Feed,
		rates: { ...h3Feed.rates, "kling-3": { kind: "tiered-by-mode", modes: { pro: "9" } } },
	};
	expect(estimatePrice(feed, input, at)).toMatchObject({ status: "known", perRequest: "80" });
});
