import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ locals }) => ({
	eligibleProviders: await locals.studio.providers.eligibleSeedreamProviders(),
});
