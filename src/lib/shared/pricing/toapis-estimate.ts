import { creditUnits, formatCredits } from "./decimal";
import type { PriceEstimate, PriceInput } from "./estimate";
import { isPricingClock, isPricingRecord, parsePricingInstant } from "./feed";
import { type ToapisPricingFeed, toapisRateExpiryMs } from "./toapis-feed";

function standardMetadata(value: unknown): boolean {
	if (!isPricingRecord(value)) return false;
	return Object.entries(value).every(([key, setting]) => {
		switch (key) {
			case "background":
				return setting === "auto" || setting === "transparent";
			case "output_format":
				return setting === "png";
			case "watermark":
			case "layer_decomposition":
				return setting === false;
			default:
				return false;
		}
	});
}

function standardImageOptions(options: Record<string, unknown>): boolean {
	return Object.entries(options).every(([key, value]) => {
		switch (key) {
			case "size":
				return true;
			case "disable_nsfw":
				// Studio sends a boolean preference. The advertised rate covers the standard route.
				return typeof value === "boolean";
			case "n":
				return value === 1;
			case "metadata":
				return standardMetadata(value);
			default:
				return false;
		}
	});
}

function standardVideoOptions(options: Record<string, unknown>, operation: string): boolean {
	return Object.entries(options).every(([key, setting]) => {
		if (key === "return_last_frame") return setting === false;
		if (key === "video_operation") return setting === operation;
		// Media lives outside the option object and is classified separately.
		return [
			"disable_nsfw",
			"aspect_ratio",
			"duration",
			"resolution",
			"generate_audio",
			"output_format",
		].includes(key);
	});
}

function seedanceVideoInput(input: PriceInput): boolean | undefined {
	const { sourceCount, sourceKinds, operation } = input;
	const sources = sourceKinds ?? [];
	if (sources.length !== sourceCount) return;
	const videos = sources.filter((kind) => kind === "video").length;
	const images = sources.filter((kind) => kind === "image").length;
	const audio = sources.filter((kind) => kind === "audio").length;
	if (videos > 10 || images > 30 || audio > 10) return;
	switch (operation) {
		case "animate":
			return images === 1 && sourceCount === 1 ? false : undefined;
		case "interpolate":
			return images === 2 && sourceCount === 2 ? false : undefined;
		case "edit":
			return videos > 0 ? true : undefined;
		case "generate":
			if (videos > 0) return true;
			return sources.includes("unknown") ? undefined : false;
	}
}

export function estimateToapis(
	feed: ToapisPricingFeed | undefined,
	input: PriceInput,
	nowMs: number,
	maxAttempts: number,
): PriceEstimate {
	const unknown = (
		reason: Extract<PriceEstimate, { status: "unknown" }>["reason"],
	): PriceEstimate => ({
		status: "unknown",
		reason,
		maxAttempts,
	});
	const { model, sourceCount, options, operation, count } = input;
	const isImage = model === "doubao-seedream-5-5";
	if (!isImage && model !== "seedance-2-5") return unknown("unsupported-model");
	if (!isPricingRecord(options)) return unknown("unsupported-input");
	const wireOperation =
		operation === "animate" || operation === "interpolate" ? "generate" : operation;
	const videoInput = isImage ? undefined : seedanceVideoInput(input);
	if (isImage) {
		const validSources =
			operation === "generate"
				? sourceCount === 0
				: operation === "edit" &&
					Number.isSafeInteger(sourceCount) &&
					sourceCount >= 1 &&
					sourceCount <= 10 &&
					(!input.sourceKinds || input.sourceKinds.every((kind) => kind === "image"));
		if (
			!validSources ||
			!standardImageOptions(options) ||
			!["1K", "1.5K", "2K"].some((size) => size === options.size)
		)
			return unknown("unsupported-input");
	} else if (videoInput === undefined || !standardVideoOptions(options, wireOperation)) {
		return unknown("unsupported-input");
	}
	if (!isPricingClock(nowMs)) return unknown("invalid-clock");
	if (!feed) return unknown("missing-feed");
	const sourceDate = feed.observedAt;
	if (nowMs < parsePricingInstant(sourceDate)) return unknown("invalid-clock");
	// Match each rate by its unit, so the reference-image charge never stands in for a tier.
	const rate = feed.rates.find(
		(rate) =>
			rate.model === model &&
			rate.operations.some((operation) => operation === wireOperation) &&
			(isImage
				? rate.unit === "image" && rate.conditions.size === options.size
				: rate.unit === "million-total-tokens" && rate.conditions.videoInput === videoInput),
	);
	// Each reference image in an edit is charged on top of the output tier.
	const references = isImage ? sourceCount : 0;
	const reference = references
		? feed.rates.find(
				(rate) =>
					rate.model === model &&
					rate.unit === "reference-image" &&
					rate.operations.some((operation) => operation === wireOperation),
			)
		: undefined;
	if (!rate || (references && !reference)) return unknown("rate-unavailable");
	const expiry = Math.min(
		toapisRateExpiryMs(feed, rate),
		reference ? toapisRateExpiryMs(feed, reference) : Number.POSITIVE_INFINITY,
	);
	if (nowMs >= expiry) return unknown("expired-feed");
	const { creditsPerUsd, conversionSourceUrl, conversionCacheAgeSeconds } = feed;
	const extra = BigInt(references);
	const credits =
		creditUnits(rate.approximateCredits) +
		extra * (reference ? creditUnits(reference.approximateCredits) : 0n);
	const usd = creditUnits(rate.usd) + extra * (reference ? creditUnits(reference.usd) : 0n);
	const provenance = {
		sourceDate,
		source: rate.source,
		creditsPerUsd,
		conversionSourceUrl,
		conversionCacheAgeSeconds,
		expiresAt: new Date(expiry).toISOString(),
	};
	if (rate.unit === "million-total-tokens") {
		return {
			status: "unknown",
			reason: "token-usage-unknown",
			maxAttempts,
			advertisedUnitRate: {
				unit: rate.unit,
				usd: formatCredits(usd),
				approximateCredits: formatCredits(credits),
				...provenance,
			},
		};
	}
	return {
		status: "known",
		unit: "toapis_credit",
		perRequest: formatCredits(credits),
		batch: formatCredits(credits * BigInt(count)),
		usd: { perRequest: formatCredits(usd), batch: formatCredits(usd * BigInt(count)) },
		maxAttempts,
		...(reference && {
			referenceImages: {
				count: references,
				usdEach: reference.usd,
				approximateCreditsEach: reference.approximateCredits,
			},
		}),
		...provenance,
	};
}
