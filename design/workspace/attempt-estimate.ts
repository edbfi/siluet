import { creditUnits, isCreditRate } from "../../src/lib/shared/pricing/decimal";
import { isPricingRecord, parsePricingInstant } from "../../src/lib/shared/pricing/feed";
import {
	decodeToapisRateSource,
	toapisConversionUrl,
	validToapisCacheAge,
} from "../../src/lib/shared/pricing/toapis-feed";

function restoreToapisProvenance(
	value: Record<string, unknown>,
	model: "doubao-seedream-5-5" | "seedance-2-5",
) {
	const { sourceDate, creditsPerUsd, conversionSourceUrl, conversionCacheAgeSeconds } = value;
	if (
		typeof sourceDate !== "string" ||
		creditsPerUsd !== "200" ||
		conversionSourceUrl !== toapisConversionUrl
	)
		return;
	const observedMs = parsePricingInstant(sourceDate);
	if (!Number.isFinite(observedMs) || !validToapisCacheAge(conversionCacheAgeSeconds, observedMs))
		return;
	const source = decodeToapisRateSource(value.source, model, observedMs);
	if (!source) return;
	return { sourceDate, source, creditsPerUsd, conversionSourceUrl, conversionCacheAgeSeconds };
}

export function restoreToapisAttempt(value: unknown, model: string) {
	if (!isPricingRecord(value)) return null;
	if (value.status === "unknown") {
		const rate = value.advertisedUnitRate;
		if (model === "seedance-2-5" && isPricingRecord(rate)) {
			const { unit, usd, approximateCredits } = rate;
			const provenance = restoreToapisProvenance(rate, model);
			if (
				unit === "million-total-tokens" &&
				isCreditRate(usd) &&
				isCreditRate(approximateCredits) &&
				creditUnits(usd) * 200n === creditUnits(approximateCredits) &&
				provenance
			) {
				return {
					status: "unknown",
					advertisedUnitRate: { unit, usd, approximateCredits, ...provenance },
				};
			}
		}
		return { status: "unknown" };
	}
	if (model !== "doubao-seedream-5-5" || value.status !== "known" || value.unit !== "toapis_credit")
		return null;
	const { status, unit, perRequest, usd } = value;
	if (
		!isCreditRate(perRequest) ||
		!isPricingRecord(usd) ||
		!isCreditRate(usd.perRequest) ||
		creditUnits(usd.perRequest) * 200n !== creditUnits(perRequest)
	)
		return null;
	const provenance = restoreToapisProvenance(value, model);
	if (!provenance) return null;
	const estimate = { status, unit, perRequest, usd: { perRequest: usd.perRequest } };
	// Quotes saved before the per-reference charge omit it.
	if (!Object.hasOwn(value, "referenceImages")) return { ...estimate, ...provenance };
	const referenceImages = restoreReferenceImages(value.referenceImages, usd.perRequest);
	return referenceImages ? { ...estimate, referenceImages, ...provenance } : null;
}

/** A per-reference charge that leaves a positive output tier within the saved total. */
function restoreReferenceImages(value: unknown, usdPerRequest: string) {
	if (
		!isPricingRecord(value) ||
		Object.keys(value).length !== 3 ||
		!Object.hasOwn(value, "count") ||
		!Object.hasOwn(value, "usdEach") ||
		!Object.hasOwn(value, "approximateCreditsEach")
	)
		return;
	const { count, usdEach, approximateCreditsEach } = value;
	if (
		typeof count !== "number" ||
		!Number.isSafeInteger(count) ||
		count < 1 ||
		count > 10 ||
		!isCreditRate(usdEach) ||
		!isCreditRate(approximateCreditsEach) ||
		creditUnits(usdEach) * 200n !== creditUnits(approximateCreditsEach) ||
		creditUnits(usdEach) * BigInt(count) >= creditUnits(usdPerRequest)
	)
		return;
	return { count, usdEach, approximateCreditsEach };
}
