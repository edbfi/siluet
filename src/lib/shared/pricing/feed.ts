import { isCreditRate } from "./decimal";

export const pricingMaxAgeMs = 30 * 24 * 60 * 60 * 1_000;

type Unavailable = Readonly<{ kind: "unavailable" }>;
type FixedRate = Readonly<{ kind: "per-request"; credits: string }>;
type ReferenceRate = Readonly<{
	kind: "per-image-with-references";
	resolutions: Readonly<Record<"1K" | "1.5K" | "2K", string>>;
	perReference: string;
}>;

export type PricingFeed = Readonly<{
	version: 1;
	provider: "poyo";
	revision: string;
	sourceDate: string;
	rates: Readonly<{
		"z-image": FixedRate | Unavailable;
		"seedream-5.5": ReferenceRate | Unavailable;
	}>;
}>;

export function isPricingRecord(value: unknown): value is Record<string, unknown> {
	if (!value || typeof value !== "object") return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

export function hasKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
	return (
		isPricingRecord(value) &&
		Object.keys(value).length === keys.length &&
		keys.every((key) => Object.hasOwn(value, key))
	);
}

export function parsePricingInstant(value: unknown): number {
	if (typeof value !== "string") return Number.NaN;
	const isoInstant =
		/^(\d{4}-\d{2}-\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;
	const match = isoInstant.exec(value);
	if (!match) return Number.NaN;
	const day = Date.parse(`${match[1]}T00:00:00Z`);
	if (!Number.isFinite(day) || new Date(day).toISOString().slice(0, 10) !== match[1]) {
		return Number.NaN;
	}
	return Date.parse(value);
}

export function isPricingClock(nowMs: number): boolean {
	return Number.isSafeInteger(nowMs) && nowMs >= 0 && nowMs <= 8_640_000_000_000_000;
}

export function pricingFeedExpiryMs(feed: PricingFeed): number {
	return parsePricingInstant(feed.sourceDate) + pricingMaxAgeMs;
}

function isUnavailable(value: unknown): boolean {
	return hasKeys(value, ["kind"]) && value.kind === "unavailable";
}

function decodeFixedRate(value: unknown): FixedRate | Unavailable | undefined {
	if (isUnavailable(value)) return { kind: "unavailable" };
	if (!hasKeys(value, ["kind", "credits"]) || value.kind !== "per-request") return;
	if (!isCreditRate(value.credits)) return;
	return { kind: value.kind, credits: value.credits };
}

function decodeReferenceRate(value: unknown): ReferenceRate | Unavailable | undefined {
	if (isUnavailable(value)) return { kind: "unavailable" };
	if (!hasKeys(value, ["kind", "resolutions", "perReference"])) return;
	const { kind, resolutions, perReference } = value;
	if (kind !== "per-image-with-references" || !isCreditRate(perReference)) return;
	if (!hasKeys(resolutions, ["1K", "1.5K", "2K"])) return;
	const { "1K": one, "1.5K": oneAndHalf, "2K": two } = resolutions;
	if (!isCreditRate(one) || !isCreditRate(oneAndHalf) || !isCreditRate(two)) return;
	return { kind, resolutions: { "1K": one, "1.5K": oneAndHalf, "2K": two }, perReference };
}

export function decodePricingFeed(value: unknown): PricingFeed | undefined {
	if (!hasKeys(value, ["version", "provider", "revision", "sourceDate", "rates"])) return;
	const { version, provider, revision, sourceDate, rates } = value;
	if (version !== 1 || provider !== "poyo") return;
	if (typeof revision !== "string" || !/^[a-f\d]{40}$/i.test(revision)) return;
	if (typeof sourceDate !== "string" || !Number.isFinite(parsePricingInstant(sourceDate))) return;
	if (!hasKeys(rates, ["z-image", "seedream-5.5"])) return;
	const fixed = decodeFixedRate(rates["z-image"]);
	const withReferences = decodeReferenceRate(rates["seedream-5.5"]);
	if (!fixed || !withReferences) return;
	return {
		version,
		provider,
		revision: revision.toLowerCase(),
		sourceDate,
		rates: { "z-image": fixed, "seedream-5.5": withReferences },
	};
}
