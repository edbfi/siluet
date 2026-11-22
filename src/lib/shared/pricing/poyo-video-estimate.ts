import { poyoVideoDescriptor } from "../video-studio/poyo-models";
import { poyoVideoOptions } from "../video-studio/poyo-video";
import { creditUnits, formatCredits } from "./decimal";
import type { PriceEstimate, PriceInput } from "./estimate";
import { isPricingClock, parsePricingInstant } from "./feed";
import {
	decodePoyoPricingFeed,
	isPerSecondRate,
	poyoConfirmationMs,
	poyoFeedExpiryMs,
} from "./poyo-feed";

type Unknown = Extract<PriceEstimate, { status: "unknown" }>["reason"];

// Exactly one reviewed text-to-video request: no references, no retries and the descriptor's
// fields with the D4 field false.
function reviewedOptions(input: PriceInput) {
	const descriptor = poyoVideoDescriptor(input.model);
	if (
		!descriptor ||
		input.operation !== "generate" ||
		input.count !== 1 ||
		input.retryLimit !== 0 ||
		input.sourceCount !== 0 ||
		(input.sourceKinds !== undefined && input.sourceKinds.length !== 0)
	)
		return;
	const { [descriptor.d4Field]: d4, ...fields } = input.options;
	if (d4 !== false) return;
	const options = poyoVideoOptions(descriptor, { prompt: "", ...fields });
	const { duration, resolution } = options ?? {};
	if (typeof duration === "number" && typeof resolution === "string")
		return { descriptor, duration, resolution };
}

/** Estimate one Poyo video request from the v2 feed's per-second rate for its model. */
export function estimatePoyoVideo(
	feed: unknown,
	input: PriceInput,
	nowMs: number,
	maxAttempts: number | null,
): PriceEstimate {
	const unknown = (reason: Unknown): PriceEstimate => ({ status: "unknown", reason, maxAttempts });
	const reviewed = reviewedOptions(input);
	if (!reviewed) return unknown("unsupported-input");
	if (!isPricingClock(nowMs)) return unknown("invalid-clock");
	const poyoFeed = decodePoyoPricingFeed(feed);
	if (!poyoFeed) return unknown("missing-feed");
	if (poyoFeed.version !== 2) return unknown("unsupported-model");
	if (nowMs < parsePricingInstant(poyoFeed.sourceDate)) return unknown("invalid-clock");
	const expiresAt = poyoFeedExpiryMs(poyoFeed, nowMs);
	if (nowMs >= expiresAt)
		return unknown(nowMs < poyoConfirmationMs(poyoFeed) ? "invalid-clock" : "expired-feed");
	const rate = poyoFeed.rates[reviewed.descriptor.rateKey];
	if (!rate || !isPerSecondRate(rate)) return unknown("rate-unavailable");
	if (!Object.hasOwn(rate.resolutions, reviewed.resolution)) return unknown("unsupported-input");
	const perRequest = creditUnits(rate.resolutions[reviewed.resolution]) * BigInt(reviewed.duration);
	return {
		status: "known",
		unit: "poyo_credit",
		perRequest: formatCredits(perRequest),
		batch: formatCredits(perRequest),
		maxAttempts: 1,
		sourceDate: poyoFeed.sourceDate,
		revision: poyoFeed.revision,
		expiresAt: new Date(expiresAt).toISOString(),
	};
}
