import { fileURLToPath } from "node:url";
import {
	type PricingFile,
	type PricingPaths,
	pricingFileLocation,
	loadBundledPricing as readBundledPricing,
	loadLocalPricing as resolveLocalPricing,
} from "../../src/lib/server/services/pricing/local-feed";
import type { PricingProvider } from "../../src/lib/shared/pricing/feeds";

export {
	type CachedPricingFeed,
	decodePricingFile,
	type PricingFile,
	type PricingPaths,
	poyoV2FileByteLimit,
	pricingCachePath,
	pricingFeedByteLimit,
	pricingFeedConflict,
	readLocalPricing,
} from "../../src/lib/server/services/pricing/local-feed";

/** Read bundled rates from the checkout. A missing v2 file falls back to the v1 feed. */
export function pricingBundledPath(file: PricingFile): string {
	return fileURLToPath(new URL(`../../pricing/${pricingFileLocation(file)}`, import.meta.url));
}

export function loadBundledPricing(provider: PricingProvider) {
	return readBundledPricing(provider, {
		bundledPath: pricingBundledPath(provider),
		v2BundledPath: pricingBundledPath("poyo-v2"),
	});
}

export function loadLocalPricing(
	nowMs: number,
	{
		provider = "poyo",
		bundledPath = pricingBundledPath(provider),
		v2BundledPath = pricingBundledPath("poyo-v2"),
		...paths
	}: PricingPaths = {},
) {
	return resolveLocalPricing(nowMs, { provider, bundledPath, v2BundledPath, ...paths });
}
