import { isCreditDecimal } from "./decimal";
import {
	decodeFixedRate,
	decodePricingFeed,
	decodeReferenceRate,
	type FixedRate,
	hasKeys,
	isPricingRecord,
	isUnavailable,
	type PricingFeed,
	parsePricingInstant,
	pricingMaxAgeMs,
	type ReferenceRate,
	type Unavailable,
} from "./feed";

/** Pattern of model IDs in the pinned Poyo.ai catalog. */
export const poyoRateKey = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
export const poyoRequiredModels = ["z-image", "seedream-5.5"] as const;
const maxRates = 1_000;
const maxDepth = 4;
const rateKind = /^[a-z][a-z0-9-]{0,63}$/;
const wholeSecond = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

export type UnfamiliarRateValue = string | UnfamiliarRateFields;
export type UnfamiliarRateFields = { readonly [key: string]: UnfamiliarRateValue };
/** A rate kind this release cannot quote. Refresh and the cache keep it unchanged. */
export type UnfamiliarRate = Readonly<{ kind: string }> & UnfamiliarRateFields;
export type PoyoRate = FixedRate | ReferenceRate | Unavailable | UnfamiliarRate;

export type PoyoPricingFeedV2 = Readonly<{
	version: 2;
	provider: "poyo";
	revision: string;
	sourceDate: string;
	confirmedAt: string;
	rates: Readonly<Record<string, PoyoRate>>;
}>;
export type PoyoPricingFeed = PricingFeed | PoyoPricingFeedV2;

// Builds keep rate kinds they do not know, but only in this shape: nested records whose leaves
// are credit decimals. A later kind must keep its leaves in that form, or older builds will
// reject the whole v2 feed and fall back to v1.
function decodeFields(value: unknown, depth: number): UnfamiliarRateFields | undefined {
	if (depth > maxDepth || !isPricingRecord(value)) return;
	const fields: Record<string, UnfamiliarRateValue> = Object.create(null);
	for (const [key, field] of Object.entries(value)) {
		if (!poyoRateKey.test(key)) return;
		if (isCreditDecimal(field)) {
			fields[key] = field;
			continue;
		}
		const child = decodeFields(field, depth + 1);
		if (!child) return;
		fields[key] = child;
	}
	return fields;
}

function decodeUnfamiliarRate(value: Record<string, unknown>): UnfamiliarRate | undefined {
	const { kind, ...rest } = value;
	if (typeof kind !== "string" || !rateKind.test(kind)) return;
	const fields = decodeFields(rest, 1);
	if (!fields) return;
	const rate: Record<string, UnfamiliarRateValue> = Object.create(null);
	rate.kind = kind;
	return Object.assign(rate, fields) as UnfamiliarRate;
}

export function decodePoyoRate(value: unknown): PoyoRate | undefined {
	if (!isPricingRecord(value)) return;
	switch (value.kind) {
		case "unavailable":
			return isUnavailable(value) ? { kind: "unavailable" } : undefined;
		case "per-request":
			return decodeFixedRate(value);
		case "per-image-with-references":
			return decodeReferenceRate(value);
		default:
			return decodeUnfamiliarRate(value);
	}
}

export function isFixedRate(rate: PoyoRate): rate is FixedRate {
	return rate.kind === "per-request";
}

export function isReferenceRate(rate: PoyoRate): rate is ReferenceRate {
	return rate.kind === "per-image-with-references";
}

function decodeRates(value: unknown): Record<string, PoyoRate> | undefined {
	if (!isPricingRecord(value)) return;
	const entries = Object.entries(value);
	if (entries.length > maxRates) return;
	if (!poyoRequiredModels.every((model) => Object.hasOwn(value, model))) return;
	const rates: Record<string, PoyoRate> = Object.create(null);
	for (const [key, entry] of entries) {
		if (!poyoRateKey.test(key)) return;
		const rate = decodePoyoRate(entry);
		if (!rate) return;
		rates[key] = rate;
	}
	return rates;
}

export function decodePoyoV2Feed(value: unknown): PoyoPricingFeedV2 | undefined {
	const keys = ["version", "provider", "revision", "sourceDate", "confirmedAt", "rates"];
	if (!hasKeys(value, keys)) return;
	const { version, provider, revision, sourceDate, confirmedAt } = value;
	if (version !== 2 || provider !== "poyo") return;
	if (typeof revision !== "string" || !/^[a-f\d]{40}$/i.test(revision)) return;
	const sourceTime = parsePricingInstant(sourceDate);
	if (typeof sourceDate !== "string" || !Number.isFinite(sourceTime)) return;
	if (typeof confirmedAt !== "string" || !wholeSecond.test(confirmedAt)) return;
	const confirmedTime = parsePricingInstant(confirmedAt);
	if (!Number.isFinite(confirmedTime) || confirmedTime < sourceTime) return;
	const rates = decodeRates(value.rates);
	if (!rates) return;
	return { version, provider, revision: revision.toLowerCase(), sourceDate, confirmedAt, rates };
}

export function decodePoyoPricingFeed(value: unknown): PoyoPricingFeed | undefined {
	return isPricingRecord(value) && value.version === 2
		? decodePoyoV2Feed(value)
		: decodePricingFeed(value);
}

/** The latest evidence that the pinned revision is current: v2's confirmation, else v1's source. */
export function poyoConfirmationMs(feed: PoyoPricingFeed): number {
	return parsePricingInstant(feed.version === 2 ? feed.confirmedAt : feed.sourceDate);
}

/**
 * Rates expire 30 days after their confirmation. A confirmation later than `nowMs` (a clock
 * behind the publisher, or a forged date) is ignored in favour of the source date, so the
 * expiry stays fixed for a given feed and cannot be extended past real time.
 */
export function poyoFeedExpiryMs(feed: PoyoPricingFeed, nowMs = Number.POSITIVE_INFINITY): number {
	const confirmed = poyoConfirmationMs(feed);
	const evidence = confirmed <= nowMs ? confirmed : parsePricingInstant(feed.sourceDate);
	return evidence + pricingMaxAgeMs;
}
