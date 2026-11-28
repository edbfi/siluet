import { isPricingRecord } from "./feed";
import type { PoyoPriceBasis } from "./poyo-basis";
import { decodePoyoPricingFeed, type PoyoPricingFeed } from "./poyo-feed";
import { decodeToapisPricingFeed, type ToapisPricingFeed } from "./toapis-feed";

export const pricingProviders = ["poyo", "toapis"] as const;
export type PricingProvider = (typeof pricingProviders)[number];
export type ProviderPricingFeed = PoyoPricingFeed | ToapisPricingFeed;
export type PricingFeeds = {
	poyo?: PoyoPricingFeed;
	/** The price basis paired with `poyo`: offered only when the server matched the pair. */
	poyoBasis?: PoyoPriceBasis;
	toapis?: ToapisPricingFeed;
};

export function isPricingProvider(value: string): value is PricingProvider {
	return pricingProviders.some((provider) => provider === value);
}

export function pricingSourceDate(feed: ProviderPricingFeed): string {
	return feed.provider === "poyo" ? feed.sourceDate : feed.observedAt;
}

export function decodePricingFeeds(value: unknown): PricingFeeds {
	if (!isPricingRecord(value)) return {};
	if (value.provider === "poyo") return { poyo: decodePoyoPricingFeed(value) };
	if (value.provider === "toapis") return { toapis: decodeToapisPricingFeed(value) };
	return {
		poyo: decodePoyoPricingFeed(value.poyo),
		toapis: decodeToapisPricingFeed(value.toapis),
	};
}
