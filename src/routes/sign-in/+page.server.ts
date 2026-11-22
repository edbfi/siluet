import { pendingCredential } from "#lib/server/services/owner/cookies.ts";
import { authenticate } from "#lib/server/services/owner/form.ts";
import type { Actions, PageServerLoad } from "./$types";
export const actions = { default: (event) => authenticate(event, false) } satisfies Actions;

export const load: PageServerLoad = async ({ locals, cookies }) => {
	const proof = pendingCredential(cookies, locals.studio.cookieName);
	return { pending: !!proof && (await locals.studio.access.security.pending(proof)) };
};
