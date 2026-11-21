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
