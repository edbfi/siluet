import { redirect } from "@sveltejs/kit";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ locals }) => {
	if (!(await locals.studio.hasOwner())) redirect(303, "/setup");
	if (locals.session) redirect(303, "/");
	return {};
};
