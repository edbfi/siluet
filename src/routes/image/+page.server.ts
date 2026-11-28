import { loadStudioPricingFeeds } from "#lib/server/services/pricing/studio-feeds.ts";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ locals }) => {
	const pricingNowMs = Date.now();
	const [availability, pricingFeeds, cleaning, refusals] = await Promise.all([
		locals.studio.providers.imageAvailability(),
		loadStudioPricingFeeds(pricingNowMs),
		// An unreadable setting leaves the mode unknown; preparation and Review refuse on the server.
		locals.studio.cleaning.read().catch(() => null),
		// Poyo.ai models the current key was refused for, which Review shows with their date.
		locals.studio.refusals.current("poyo"),
	]);
	return { ...availability, pricingFeeds, pricingNowMs, cleaning, refusals };
};
