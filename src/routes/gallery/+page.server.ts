import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ locals }) => ({
	images: await locals.studio.gallery.list(),
});
