import poyoFeed from "../../../../../pricing/v1/feed.json";
import poyoV2Feed from "../../../../../pricing/v2/poyo.json";
import toapisFeed from "../../../../../pricing/v2/toapis.json";
import { decodePricingFeed } from "../../../shared/pricing/feed";
import type { PricingFeeds, PricingProvider } from "../../../shared/pricing/feeds";
import { decodePoyoV2Feed } from "../../../shared/pricing/poyo-feed";
import { decodeToapisPricingFeed } from "../../../shared/pricing/toapis-feed";
import {
	type BundledPricingFeeds,
	loadLocalPoyoPricing,
	loadLocalPricing,
	pricingCachePath,
	loadBundledPricing as selectBundledPricing,
} from "./local-feed";

/**
 * The rates embedded in the Studio build. The CLI reads the checkout's files instead. No price
 * basis is bundled until pricing-data publishes one: the first re-bundle adds
 * `pricing/v2/poyo-basis.json` and embeds it here as `"poyo-basis"`, decoded with
 * `decodePoyoBasis`, so derived rows stay unknown-price until then.
 */
const embeddedFeeds: BundledPricingFeeds = {
	poyo: decodePricingFeed(poyoFeed),
	"poyo-v2": decodePoyoV2Feed(poyoV2Feed),
	toapis: decodeToapisPricingFeed(toapisFeed),
};

export function loadBundledPricing(provider: PricingProvider) {
	return selectBundledPricing(provider, { bundledFeeds: embeddedFeeds });
}

/** Load the selected local snapshots for use during browser-only composition and review. */
export async function loadStudioPricingFeeds(
	nowMs: number,
	cacheHome?: string,
): Promise<PricingFeeds> {
	const [poyo, toapis] = await Promise.all([
		loadLocalPoyoPricing(nowMs, {
			bundledFeeds: embeddedFeeds,
			cachePath: pricingCachePath(cacheHome, "poyo"),
			v2CachePath: pricingCachePath(cacheHome, "poyo-v2"),
		}),
		loadLocalPricing(nowMs, {
			provider: "toapis",
			bundledFeeds: embeddedFeeds,
			cachePath: pricingCachePath(cacheHome, "toapis"),
		}),
	]);
	return {
		poyo: poyo.feed,
		...(poyo.basis && { poyoBasis: poyo.basis }),
		toapis: toapis?.provider === "toapis" ? toapis : undefined,
	};
}
