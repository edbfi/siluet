import { poyoVideoDescriptor } from "../video-studio/poyo-models";
import { creditUnits, formatCredits } from "./decimal";
import { isPricingClock, isPricingRecord, parsePricingInstant } from "./feed";
import {
	decodePoyoPricingFeed,
	isFixedRate,
	isReferenceRate,
	type PoyoRate,
	poyoConfirmationMs,
	poyoFeedExpiryMs,
} from "./poyo-feed";
import { estimatePoyoVideo } from "./poyo-video-estimate";
import { estimateToapis } from "./toapis-estimate";
import { decodeToapisPricingFeed, type ToapisRateSource } from "./toapis-feed";

const sourceKinds = ["image", "video", "audio", "unknown"] as const;
type PriceSourceKind = (typeof sourceKinds)[number];

export function isPriceSourceKind(value: unknown): value is PriceSourceKind {
	return sourceKinds.some((kind) => kind === value);
}

export type PriceInput = Readonly<{
	provider: string;
	model: string;
	operation: string;
	options: Readonly<Record<string, unknown>>;
	sourceCount: number;
	sourceKinds?: readonly PriceSourceKind[];
	count: number;
	retryLimit: number;
}>;

type UnknownReason =
	| "unsupported-provider"
	| "unsupported-model"
	| "unsupported-input"
	| "missing-feed"
	| "expired-feed"
	| "invalid-clock"
	| "rate-unavailable"
	| "token-usage-unknown";

export type ToapisReferenceImages = {
	count: number;
	usdEach: string;
	approximateCreditsEach: string;
};

type ToapisProvenance = {
	sourceDate: string;
	source: ToapisRateSource;
	creditsPerUsd: string;
	conversionSourceUrl: string;
	conversionCacheAgeSeconds: number | null;
	expiresAt: string;
};

export type PriceEstimate =
	| {
			status: "known";
			unit: "poyo_credit";
			perRequest: string;
			batch: string;
			maxAttempts: number;
			sourceDate: string;
			revision: string;
			expiresAt: string;
	  }
	| ({
			status: "known";
			unit: "toapis_credit";
			perRequest: string;
			batch: string;
			usd: { perRequest: string; batch: string };
			maxAttempts: number;
			/** The per-reference charge included in each request. Older stored quotes omit it. */
			referenceImages?: ToapisReferenceImages;
	  } & ToapisProvenance)
	| {
			status: "unknown";
			reason: UnknownReason;
			maxAttempts: number | null;
			advertisedUnitRate?: {
				unit: "million-total-tokens";
				usd: string;
				approximateCredits: string;
			} & ToapisProvenance;
	  };

const inputKeys = [
	"provider",
	"model",
	"operation",
	"options",
	"sourceCount",
	"count",
	"retryLimit",
];
const zImageSizes = ["1:1", "4:3", "3:4", "16:9", "9:16"];
const seedreamSizes = [...zImageSizes, "3:2", "2:3", "21:9"];
const zImageOptions = ["size", "enable_safety_checker"];
const seedreamOptions = [...zImageOptions, "resolution", "background", "output_format"];

function validCount(value: number, min: number, max: number): boolean {
	return Number.isSafeInteger(value) && value >= min && value <= max;
}

function validSize(size: unknown, sizes: readonly string[]): boolean {
	return typeof size === "string" && sizes.includes(size);
}

function hasOnlyOptions(options: Readonly<Record<string, unknown>>, allowed: readonly string[]) {
	return (
		isPricingRecord(options) &&
		Object.keys(options).every((key) => allowed.includes(key) && options[key] !== undefined) &&
		(!Object.hasOwn(options, "enable_safety_checker") ||
			typeof options.enable_safety_checker === "boolean")
	);
}

function supportsZImage({ operation, sourceCount, options }: PriceInput): boolean {
	if (!hasOnlyOptions(options, zImageOptions)) return false;
	if (operation === "generate") {
		return sourceCount === 0 && validSize(options.size, zImageSizes);
	}
	return (
		operation === "edit" &&
		sourceCount === 1 &&
		(!Object.hasOwn(options, "size") || validSize(options.size, zImageSizes))
	);
}

function seedreamTier({ operation, sourceCount, options }: PriceInput) {
	if (!hasOnlyOptions(options, seedreamOptions)) return;
	if (
		operation === "generate"
			? sourceCount !== 0
			: operation !== "edit" || !validCount(sourceCount, 1, 10)
	) {
		return;
	}

	const {
		size,
		resolution = "2K",
		background = "auto",
		output_format: outputFormat = "png",
	} = options;
	if (
		size !== undefined &&
		!validSize(size, seedreamSizes) &&
		!(size === "auto" && operation === "edit")
	) {
		return;
	}
	if (background !== "auto" && background !== "opaque" && background !== "transparent") return;
	if (outputFormat !== "png" && outputFormat !== "jpeg") return;
	if (background === "transparent" && outputFormat !== "png") return;
	if (resolution === "1K" || resolution === "1.5K" || resolution === "2K") return resolution;
}

export function estimatePrice(feed: unknown, input: PriceInput, nowMs: number): PriceEstimate {
	if (!isPricingRecord(input)) {
		return { status: "unknown", reason: "unsupported-input", maxAttempts: null };
	}
	const { count, retryLimit, provider, model, sourceCount } = input;
	const maxAttempts =
		validCount(count, 1, 5) && validCount(retryLimit, 0, 3) ? count * (1 + retryLimit) : null;
	const unknown = (reason: UnknownReason): PriceEstimate => ({
		status: "unknown",
		reason,
		maxAttempts,
	});

	if (
		maxAttempts === null ||
		!inputKeys.every((key) => Object.hasOwn(input, key)) ||
		Object.keys(input).some((key) => key !== "sourceKinds" && !inputKeys.includes(key)) ||
		(input.sourceKinds !== undefined &&
			(!Array.isArray(input.sourceKinds) ||
				input.sourceKinds.length !== sourceCount ||
				input.sourceKinds.length > 50 ||
				!Array.from(input.sourceKinds).every(isPriceSourceKind)))
	) {
		return unknown("unsupported-input");
	}
	if (isPricingRecord(feed) && feed.provider !== undefined && provider !== feed.provider)
		return unknown("unsupported-provider");
	if (provider === "toapis") {
		return estimateToapis(decodeToapisPricingFeed(feed), input, nowMs, maxAttempts);
	}
	if (provider !== "poyo") return unknown("unsupported-provider");
	if (poyoVideoDescriptor(model)) return estimatePoyoVideo(feed, input, nowMs, maxAttempts);
	const poyoFeed = decodePoyoPricingFeed(feed);
	if (model !== "z-image" && model !== "seedream-5.5") return unknown("unsupported-model");
	if (input.sourceKinds?.some((kind) => kind !== "image")) return unknown("unsupported-input");
	const tier = model === "seedream-5.5" ? seedreamTier(input) : undefined;
	if (model === "z-image" ? !supportsZImage(input) : tier === undefined) {
		return unknown("unsupported-input");
	}
	if (!isPricingClock(nowMs)) return unknown("invalid-clock");
	if (!poyoFeed) return unknown("missing-feed");
	if (nowMs < parsePricingInstant(poyoFeed.sourceDate)) {
		return unknown("invalid-clock");
	}
	// A confirmation dated after the clock is ignored, so the rates age from the source date.
	const expiresAt = poyoFeedExpiryMs(poyoFeed, nowMs);
	if (nowMs >= expiresAt) {
		// Refresh cannot help while the clock is behind the confirmation it already holds.
		return unknown(nowMs < poyoConfirmationMs(poyoFeed) ? "invalid-clock" : "expired-feed");
	}

	// Quote only the kind each model is known to use. Anything else is unavailable here.
	const rate: PoyoRate | undefined = poyoFeed.rates[model];
	let perRequest: bigint;
	if (model === "z-image" && rate && isFixedRate(rate)) {
		perRequest = creditUnits(rate.credits);
	} else if (model === "seedream-5.5" && rate && isReferenceRate(rate) && tier !== undefined) {
		perRequest =
			creditUnits(rate.resolutions[tier]) + BigInt(sourceCount) * creditUnits(rate.perReference);
	} else {
		return unknown("rate-unavailable");
	}
	return {
		status: "known",
		unit: "poyo_credit",
		perRequest: formatCredits(perRequest),
		batch: formatCredits(perRequest * BigInt(count)),
		maxAttempts,
		sourceDate: poyoFeed.sourceDate,
		revision: poyoFeed.revision,
		expiresAt: new Date(expiresAt).toISOString(),
	};
}
