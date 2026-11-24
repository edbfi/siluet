import { creditUnits, isCreditRate } from "./decimal";
import { hasKeys, parsePricingInstant, pricingMaxAgeMs } from "./feed";

const imageModel = "doubao-seedream-5-5";
const videoModel = "seedance-2-5";
export const toapisConversionUrl = "https://toapis.com/pricing";
const operations = ["generate", "edit"] as const;
const sizes = ["1K", "1.5K", "2K"] as const;
type Size = (typeof sizes)[number];
type Model = typeof imageModel | typeof videoModel;

export type ToapisRateSource = Readonly<{
	url: string;
	scope: "public-advertised";
	region: "global-site";
	tier: null;
	publishedAt: null;
	cacheAgeSeconds: number | null;
}>;

type Rate = Readonly<{
	operations: typeof operations;
	usd: string;
	approximateCredits: string;
	source: ToapisRateSource;
}>;

export type ToapisRate = Rate &
	(
		| {
				model: typeof imageModel;
				unit: "image";
				conditions: { size: Size; outputCount: 1; layerDecomposition: false };
		  }
		| {
				// Each reference image in `image_urls`, charged on top of the output tier.
				model: typeof imageModel;
				unit: "reference-image";
				conditions: { freeAllowance: 0 };
		  }
		| {
				model: typeof videoModel;
				unit: "million-total-tokens";
				conditions: { videoInput: boolean };
		  }
	);

const gaps = [
	{ model: imageModel, reason: "unpriced-image-options" },
	{ model: videoModel, reason: "token-usage-unknown" },
] as const;

export type ToapisPricingFeed = Readonly<{
	version: 1 | 2;
	provider: "toapis";
	observedAt: string;
	creditsPerUsd: string;
	conversionSourceUrl: typeof toapisConversionUrl;
	// Whole seconds from each response's receipt to observedAt. Older v1 bundles omit this field.
	receiptDelaySeconds?: Readonly<{ conversion: number; image: number; video: number }>;
	conversionCacheAgeSeconds: number | null;
	rates: readonly ToapisRate[];
	gaps: typeof gaps;
}>;

export function validToapisCacheAge(value: unknown, observedMs: number): value is number | null {
	return (
		value === null ||
		(typeof value === "number" &&
			Number.isSafeInteger(value) &&
			value >= 0 &&
			value * 1000 <= observedMs)
	);
}

export function decodeToapisRateSource(
	value: unknown,
	model: Model,
	observedMs: number,
): ToapisRateSource | undefined {
	if (!hasKeys(value, ["url", "scope", "region", "tier", "publishedAt", "cacheAgeSeconds"])) {
		return;
	}
	const { url, scope, region, tier, publishedAt, cacheAgeSeconds } = value;
	if (
		url !== `https://toapis.com/model-guide/${model}` ||
		scope !== "public-advertised" ||
		region !== "global-site" ||
		tier !== null ||
		publishedAt !== null ||
		!validToapisCacheAge(cacheAgeSeconds, observedMs)
	)
		return;
	return { url, scope, region, tier, publishedAt, cacheAgeSeconds };
}

function decodeRate(value: unknown, observedMs: number): ToapisRate | undefined {
	if (
		!hasKeys(value, [
			"model",
			"operations",
			"unit",
			"conditions",
			"usd",
			"approximateCredits",
			"source",
		])
	)
		return;
	const { model, unit, conditions, usd, approximateCredits } = value;
	if (model !== imageModel && model !== videoModel) return;
	const rawOperations: unknown = value.operations;
	if (
		!Array.isArray(rawOperations) ||
		rawOperations.length !== operations.length ||
		!operations.every((operation, index) => rawOperations[index] === operation)
	)
		return;
	const source = decodeToapisRateSource(value.source, model, observedMs);
	if (
		!source ||
		!isCreditRate(usd) ||
		!isCreditRate(approximateCredits) ||
		creditUnits(usd) * 200n !== creditUnits(approximateCredits)
	)
		return;
	const rate = {
		operations,
		usd,
		approximateCredits,
		source,
	};
	if (
		model === imageModel &&
		unit === "image" &&
		hasKeys(conditions, ["size", "outputCount", "layerDecomposition"]) &&
		conditions.outputCount === 1 &&
		conditions.layerDecomposition === false
	) {
		const size = sizes.find((tier) => tier === conditions.size);
		if (size)
			return {
				model,
				unit,
				conditions: { size, outputCount: 1, layerDecomposition: false },
				...rate,
			};
	}
	if (
		model === imageModel &&
		unit === "reference-image" &&
		hasKeys(conditions, ["freeAllowance"]) &&
		conditions.freeAllowance === 0
	) {
		return { model, unit, conditions: { freeAllowance: 0 }, ...rate };
	}
	if (
		model === videoModel &&
		unit === "million-total-tokens" &&
		hasKeys(conditions, ["videoInput"]) &&
		typeof conditions.videoInput === "boolean"
	) {
		return { model, unit, conditions: { videoInput: conditions.videoInput }, ...rate };
	}
}

/** The rate's position: the tiers, the reference image (v2 only), then the two video inputs. */
function rateKey(rate: ToapisRate, referenceRates: 0 | 1): number {
	switch (rate.unit) {
		case "image":
			return sizes.indexOf(rate.conditions.size);
		case "reference-image":
			return referenceRates ? sizes.length : -1;
		case "million-total-tokens":
			return sizes.length + referenceRates + Number(rate.conditions.videoInput);
	}
}

export function decodeToapisPricingFeed(value: unknown): ToapisPricingFeed | undefined {
	const hasDelays =
		value !== null && typeof value === "object" && Object.hasOwn(value, "receiptDelaySeconds");
	if (
		!hasKeys(value, [
			...(hasDelays ? ["receiptDelaySeconds"] : []),
			"version",
			"provider",
			"observedAt",
			"creditsPerUsd",
			"conversionSourceUrl",
			"conversionCacheAgeSeconds",
			"rates",
			"gaps",
		])
	)
		return;
	const {
		version,
		provider,
		observedAt,
		creditsPerUsd,
		conversionSourceUrl,
		conversionCacheAgeSeconds,
	} = value;
	if (
		(version !== 1 && version !== 2) ||
		(version === 2 && !hasDelays) ||
		provider !== "toapis" ||
		creditsPerUsd !== "200" ||
		conversionSourceUrl !== toapisConversionUrl ||
		typeof observedAt !== "string"
	)
		return;
	const observedMs = parsePricingInstant(observedAt);
	if (
		!Number.isFinite(observedMs) ||
		observedMs < 0 ||
		`${new Date(observedMs).toISOString().slice(0, 19)}Z` !== observedAt ||
		!validToapisCacheAge(conversionCacheAgeSeconds, observedMs)
	)
		return;
	let receiptDelaySeconds: ToapisPricingFeed["receiptDelaySeconds"];
	if (hasDelays) {
		const delays = value.receiptDelaySeconds;
		if (!hasKeys(delays, ["conversion", "image", "video"])) return;
		const { conversion, image, video } = delays;
		if (
			typeof conversion !== "number" ||
			typeof image !== "number" ||
			typeof video !== "number" ||
			![conversion, image, video].every(Number.isSafeInteger) ||
			video < 0 ||
			image < video ||
			conversion < image ||
			(conversion + (conversionCacheAgeSeconds ?? 0)) * 1000 > observedMs
		)
			return;
		receiptDelaySeconds = { conversion, image, video };
	}
	const rawRates: unknown = value.rates;
	const rawGaps: unknown = value.gaps;
	const referenceRates = version === 2 ? 1 : 0;
	if (
		!Array.isArray(rawRates) ||
		rawRates.length !== sizes.length + referenceRates + 2 ||
		!Array.isArray(rawGaps) ||
		rawGaps.length !== gaps.length ||
		!gaps.every(({ model, reason }, index) => {
			const gap: unknown = rawGaps[index];
			return hasKeys(gap, ["model", "reason"]) && gap.model === model && gap.reason === reason;
		})
	)
		return;
	const rates: ToapisRate[] = [];
	for (const raw of rawRates as unknown[]) {
		const rate = decodeRate(raw, observedMs);
		if (!rate || rateKey(rate, referenceRates) !== rates.length) return;
		if (effectiveRateObservationMs(observedMs, receiptDelaySeconds, rate) < 0) return;
		rates.push(rate);
	}
	const [one, oneAndHalf] = rates;
	// The reference rate comes from the same Seedream page as the tiers.
	const seedream = rates.slice(0, sizes.length + referenceRates);
	const [withoutVideo, withVideo] = rates.slice(sizes.length + referenceRates);
	if (
		one.usd !== oneAndHalf.usd ||
		one.approximateCredits !== oneAndHalf.approximateCredits ||
		seedream.some((rate) => rate.source.cacheAgeSeconds !== one.source.cacheAgeSeconds) ||
		withoutVideo.source.cacheAgeSeconds !== withVideo.source.cacheAgeSeconds
	)
		return;
	return {
		version,
		provider,
		observedAt,
		creditsPerUsd,
		conversionSourceUrl,
		conversionCacheAgeSeconds,
		...(receiptDelaySeconds && { receiptDelaySeconds }),
		rates,
		gaps,
	};
}

function effectiveRateObservationMs(
	observedMs: number,
	delays: ToapisPricingFeed["receiptDelaySeconds"],
	rate: ToapisRate,
): number {
	const delay = rate.model === imageModel ? delays?.image : delays?.video;
	return observedMs - ((delay ?? 0) + (rate.source.cacheAgeSeconds ?? 0)) * 1000;
}

function conversionObservationMs(feed: ToapisPricingFeed, observedMs: number): number {
	return (
		observedMs -
		((feed.receiptDelaySeconds?.conversion ?? 0) + (feed.conversionCacheAgeSeconds ?? 0)) * 1000
	);
}

export function toapisEffectiveObservations(feed: ToapisPricingFeed) {
	const observedMs = parsePricingInstant(feed.observedAt);
	return [
		conversionObservationMs(feed, observedMs),
		...feed.rates.map((rate) =>
			effectiveRateObservationMs(observedMs, feed.receiptDelaySeconds, rate),
		),
	];
}

export function toapisRateExpiryMs(feed: ToapisPricingFeed, rate: ToapisRate): number {
	const observedMs = parsePricingInstant(feed.observedAt);
	return (
		Math.min(
			conversionObservationMs(feed, observedMs),
			effectiveRateObservationMs(observedMs, feed.receiptDelaySeconds, rate),
		) + pricingMaxAgeMs
	);
}

export function toapisFeedExpiryMs(feed: ToapisPricingFeed): number {
	return Math.min(...toapisEffectiveObservations(feed)) + pricingMaxAgeMs;
}
