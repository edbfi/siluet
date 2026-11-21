import { loadStudioPricingFeeds } from "#lib/server/services/pricing/local-feed.ts";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ locals }) => {
	const pricingNowMs = Date.now();
	const [eligibleProviders, pricingFeeds] = await Promise.all([
		locals.studio.providers.eligibleSeedreamProviders(),
		loadStudioPricingFeeds(pricingNowMs),
	]);
	return { eligibleProviders, pricingFeeds, pricingNowMs };
};
