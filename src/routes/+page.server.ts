import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = ({ locals }) => ({ username: locals.owner });
