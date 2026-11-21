import type { PricingFeed } from "./feed";
import type { ToapisPricingFeed } from "./toapis-feed";

export const pricingProviders = ["poyo", "toapis"] as const;
export type PricingProvider = (typeof pricingProviders)[number];
export type ProviderPricingFeed = PricingFeed | ToapisPricingFeed;

export function isPricingProvider(value: string): value is PricingProvider {
	return pricingProviders.some((provider) => provider === value);
}

export function pricingSourceDate(feed: ProviderPricingFeed): string {
	return feed.provider === "poyo" ? feed.sourceDate : feed.observedAt;
}
