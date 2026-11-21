import { fileURLToPath } from "node:url";
import {
	type PricingPaths,
	loadBundledPricing as readBundledPricing,
	loadLocalPricing as resolveLocalPricing,
} from "../../src/lib/server/services/pricing/local-feed";
import type { PricingProvider } from "../../src/lib/shared/pricing/feeds";

export {
	type CachedPricingFeed,
	decodeProviderFeed,
	type PricingPaths,
	pricingCachePath,
	pricingFeedByteLimit,
	pricingFeedConflict,
	readLocalPricing,
} from "../../src/lib/server/services/pricing/local-feed";

const filenames = { poyo: "feed.json", toapis: "toapis.json" } as const;

export function pricingBundledPath(provider: PricingProvider): string {
	return fileURLToPath(new URL(`../../pricing/v1/${filenames[provider]}`, import.meta.url));
}

export function loadBundledPricing(provider: PricingProvider) {
	return readBundledPricing(provider, pricingBundledPath(provider));
}

export function loadLocalPricing(
	nowMs: number,
	{ provider = "poyo", bundledPath = pricingBundledPath(provider), cachePath }: PricingPaths = {},
) {
	return resolveLocalPricing(nowMs, { provider, bundledPath, cachePath });
}
