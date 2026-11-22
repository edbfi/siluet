import { loadStudioPricingFeeds } from "#lib/server/services/pricing/local-feed.ts";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ locals }) => {
	const pricingNowMs = Date.now();
	const [availability, pricingFeeds] = await Promise.all([
		locals.studio.providers.imageAvailability(),
		loadStudioPricingFeeds(pricingNowMs),
	]);
	return { ...availability, pricingFeeds, pricingNowMs };
};
