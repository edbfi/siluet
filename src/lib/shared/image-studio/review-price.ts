import { estimatePrice, type PriceEstimate, type PriceInput } from "../pricing/estimate";
import { parsePricingInstant } from "../pricing/feed";
import type { PricingFeeds, PricingProvider } from "../pricing/feeds";

export type ReviewPricingInput = Omit<PriceInput, "provider" | "count" | "retryLimit"> & {
	readonly provider: PricingProvider;
};

export const reviewBatchCounts = [1, 2, 3, 4, 5] as const;
export const reviewRetryLimits = [0, 1, 2, 3] as const;
type Batch = Readonly<{ count: number; retryLimit: number }>;

export function maximumReviewAttempts({ count, retryLimit }: Batch): number {
	return count * (1 + retryLimit);
}

export function estimateReviewPrice(
	feeds: PricingFeeds,
	input: ReviewPricingInput,
	batch: Batch,
	nowMs: number,
): PriceEstimate {
	return estimatePrice(feeds[input.provider], { ...input, ...batch }, nowMs);
}

const priceReasons = {
	"unsupported-provider": "Local rates do not cover this provider.",
	"unsupported-model": "Local rates do not cover this model.",
	"unsupported-input": "Local rates do not cover these options.",
	"missing-feed": "No local rate feed is available.",
	"expired-feed": "The local rate evidence is 30 days old or older.",
	"invalid-clock": "The current time does not match the local rate evidence.",
	"rate-unavailable": "No local rate is available for this request.",
	"token-usage-unknown": "The total depends on token usage.",
} satisfies Record<Extract<PriceEstimate, { status: "unknown" }>["reason"], string>;

export function reviewPriceReason(estimate: PriceEstimate): string | undefined {
	if (estimate.status === "unknown") return priceReasons[estimate.reason];
}

export function reviewPriceExpiry(estimate: PriceEstimate | undefined): number | undefined {
	const expiry =
		estimate?.status === "known" ? estimate.expiresAt : estimate?.advertisedUnitRate?.expiresAt;
	if (expiry !== undefined) return parsePricingInstant(expiry);
}

const maximumTimerDelay = 2_147_483_647;
type ReviewTimer = {
	now: () => number;
	schedule: (callback: () => void, milliseconds: number) => () => void;
};

const systemTimer: ReviewTimer = {
	now: () => Date.now(),
	schedule(callback, milliseconds) {
		const timer = setTimeout(callback, milliseconds);
		return () => clearTimeout(timer);
	},
};

export function watchReviewExpiry(
	expiresAt: number,
	update: (nowMs: number) => void,
	timer = systemTimer,
): () => void {
	let cancel: (() => void) | undefined;
	function refresh() {
		const now = timer.now();
		update(now);
		if (now < expiresAt)
			cancel = timer.schedule(refresh, Math.min(expiresAt - now, maximumTimerDelay));
	}
	refresh();
	return () => cancel?.();
}
