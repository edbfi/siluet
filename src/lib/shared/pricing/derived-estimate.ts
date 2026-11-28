// The price of a derived Poyo.ai text-to-image request (catalog engine spec, Pricing). A rate
// applies only on an exact fit: the selected v2 feed, a basis paired with it, the row's own
// digest in that basis, and resolved options that match a published tier.
import type { QueueRow } from "../media-catalog/queue-row";
import { creditUnits, formatCredits } from "./decimal";
import type { PriceEstimate } from "./estimate";
import { isPricingClock, parsePricingInstant } from "./feed";
import type { PricingFeeds } from "./feeds";
import {
	isFixedRate,
	isTierRate,
	poyoConfirmationMs,
	poyoFeedExpiryMs,
	poyoTierKey,
} from "./poyo-feed";

type Reason = Extract<PriceEstimate, { status: "unknown" }>["reason"];
/** A derived row queues one request with zero retries. */
const maxAttempts = 1;
const unknown = (reason: Reason): PriceEstimate => ({ status: "unknown", reason, maxAttempts });

/** The credits for one request at a tier rate, matching the resolution case-insensitively. */
function tierCredits(resolutions: Readonly<Record<string, string>>, resolution: unknown) {
	if (typeof resolution !== "string") return;
	const wanted = poyoTierKey(resolution).toLowerCase();
	return Object.entries(resolutions).find(([tier]) => tier.toLowerCase() === wanted)?.[1];
}

/**
 * The estimate for a derived row's validated draft options. The server pairs the basis with the
 * feed's body digest before it offers either; this also requires the same revision.
 */
export function estimateDerivedPrice(
	{ poyo: feed, poyoBasis: basis }: PricingFeeds,
	row: QueueRow,
	options: Readonly<Record<string, unknown>>,
	nowMs: number,
): PriceEstimate {
	if (!isPricingClock(nowMs)) return unknown("invalid-clock");
	if (!feed) return unknown("missing-feed");
	if (nowMs < parsePricingInstant(feed.sourceDate)) return unknown("invalid-clock");
	const expiresAt = poyoFeedExpiryMs(feed, nowMs);
	if (nowMs >= expiresAt)
		return unknown(nowMs < poyoConfirmationMs(feed) ? "invalid-clock" : "expired-feed");
	// A v1 feed carries no derived rate, and its basis cannot pair with it.
	if (feed.version !== 2 || !basis || basis.revision !== feed.revision)
		return unknown("rate-unavailable");
	if (!Object.hasOwn(basis.digests, row.rateKey) || basis.digests[row.rateKey] !== row.basis)
		return unknown("rate-unavailable");
	const rate = Object.hasOwn(feed.rates, row.rateKey) ? feed.rates[row.rateKey] : undefined;
	let credits: string | undefined;
	if (rate && isFixedRate(rate)) credits = rate.credits;
	else if (rate && isTierRate(rate)) {
		// A derived row queues one image per request (`n: 1` or no count field), so a per-image
		// tier charges once.
		credits = tierCredits(rate.resolutions, options.resolution);
		if (credits === undefined) return unknown("unsupported-input");
	} else return unknown("rate-unavailable");
	const perRequest = formatCredits(creditUnits(credits));
	return {
		status: "known",
		unit: "poyo_credit",
		perRequest,
		batch: perRequest,
		maxAttempts,
		sourceDate: feed.sourceDate,
		revision: feed.revision,
		expiresAt: new Date(expiresAt).toISOString(),
	};
}
