import { redirect } from "@sveltejs/kit";
import { signOutNoticeName, signOutNoticeValue } from "#lib/shared/owner/session-notice.ts";
import type { Actions, PageServerLoad } from "./$types";
export const load: PageServerLoad = ({ locals }) => ({ username: locals.owner });
export const actions = {
	signout: async ({ locals, cookies }) => {
		const { access, cookieName, origin } = locals.studio;
		await access.signOut(cookies.get(cookieName));
		const secure = origin.protocol === "https:";
		cookies.delete(cookieName, { path: "/", secure });
		// Publish a public notice so other tabs can observe the successful POST.
		cookies.set(signOutNoticeName(origin), signOutNoticeValue, {
			path: "/",
			secure,
			httpOnly: false,
			sameSite: "strict",
		});
		redirect(303, "/sign-in");
	},
} satisfies Actions;
