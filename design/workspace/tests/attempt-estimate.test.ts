import { expect, test } from "bun:test";
import { toapisRates } from "../../../tests/fixtures/toapis-feed";
import { restoreToapisAttempt } from "../attempt-estimate";

test("saved ToAPIs estimates must agree with their conversion and public source", () => {
	const model = "doubao-seedream-5-5";
	const estimate = {
		status: "known",
		unit: "toapis_credit",
		perRequest: "5.6",
		usd: { perRequest: "0.028" },
		source: toapisRates.rates[0].source,
		sourceDate: toapisRates.observedAt,
		creditsPerUsd: toapisRates.creditsPerUsd,
		conversionSourceUrl: toapisRates.conversionSourceUrl,
		conversionCacheAgeSeconds: null,
	};
	expect(restoreToapisAttempt(estimate, model)).toEqual(estimate);
	for (const change of [
		{ creditsPerUsd: "1" },
		{ perRequest: "3.2" },
		{ conversionSourceUrl: "https://example.invalid" },
	]) {
		expect(restoreToapisAttempt({ ...estimate, ...change }, model)).toBeNull();
	}
});

test("a saved ToAPIs edit keeps a consistent per-reference charge", () => {
	const model = "doubao-seedream-5-5";
	const referenceImages = { count: 2, usdEach: "0.0064", approximateCreditsEach: "1.28" };
	const estimate = {
		status: "known",
		unit: "toapis_credit",
		perRequest: "8.16",
		usd: { perRequest: "0.0408" },
		referenceImages,
		source: toapisRates.rates[0].source,
		sourceDate: toapisRates.observedAt,
		creditsPerUsd: toapisRates.creditsPerUsd,
		conversionSourceUrl: toapisRates.conversionSourceUrl,
		conversionCacheAgeSeconds: null,
	};
	expect(restoreToapisAttempt(estimate, model)).toEqual(estimate);
	for (const change of [
		{ count: 0 },
		{ count: 11 },
		{ count: 1.5 },
		{ approximateCreditsEach: "1.3" },
		{ usdEach: "0", approximateCreditsEach: "0" },
		{ usdEach: "0.0204", approximateCreditsEach: "4.08" },
		{ extra: true },
	]) {
		expect(
			restoreToapisAttempt(
				{ ...estimate, referenceImages: { ...referenceImages, ...change } },
				model,
			),
		).toBeNull();
	}
	expect(restoreToapisAttempt({ ...estimate, referenceImages: null }, model)).toBeNull();
});
