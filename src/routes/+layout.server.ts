import { signOutNoticeName } from "#lib/shared/owner/session-notice.ts";
import type { LayoutServerLoad } from "./$types";

export const load: LayoutServerLoad = ({ locals, cookies }) => ({
	username: locals.owner,
	signOutGeneration: locals.owner
		? (cookies.get(signOutNoticeName(locals.studio.origin)) ?? null)
		: null,
});
