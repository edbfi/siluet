import { decodePricingFeed, isPricingRecord, type PricingFeed } from "./feed";
import { decodeToapisPricingFeed, type ToapisPricingFeed } from "./toapis-feed";

export const pricingProviders = ["poyo", "toapis"] as const;
export type PricingProvider = (typeof pricingProviders)[number];
export type ProviderPricingFeed = PricingFeed | ToapisPricingFeed;
export type PricingFeeds = { poyo?: PricingFeed; toapis?: ToapisPricingFeed };

export function isPricingProvider(value: string): value is PricingProvider {
	return pricingProviders.some((provider) => provider === value);
}

export function pricingSourceDate(feed: ProviderPricingFeed): string {
	return feed.provider === "poyo" ? feed.sourceDate : feed.observedAt;
}

export function decodePricingFeeds(value: unknown): PricingFeeds {
	if (!isPricingRecord(value)) return {};
	if (value.provider === "poyo") return { poyo: decodePricingFeed(value) };
	if (value.provider === "toapis") return { toapis: decodeToapisPricingFeed(value) };
	return { poyo: decodePricingFeed(value.poyo), toapis: decodeToapisPricingFeed(value.toapis) };
}
