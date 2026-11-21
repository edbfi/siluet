import { redirect } from "@sveltejs/kit";
import { signOutNoticeName } from "#lib/shared/owner/session-notice.ts";
import type { Actions, PageServerLoad } from "./$types";
export const load: PageServerLoad = ({ locals }) => ({ username: locals.owner });
export const actions = {
	signout: async ({ locals, cookies }) => {
		const { access, cookieName, origin } = locals.studio;
		await access.signOut(cookies.get(cookieName));
		const secure = origin.protocol === "https:";
		cookies.delete(cookieName, { path: "/", secure });
		// Retain the public generation through sign-in so resumed tabs can detect revocation.
		cookies.set(signOutNoticeName(origin), crypto.randomUUID(), {
			path: "/",
			secure,
			httpOnly: false,
			sameSite: "lax",
		});
		redirect(303, "/sign-in");
	},
} satisfies Actions;
