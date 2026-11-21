import { redirect } from "@sveltejs/kit";
import type { Actions, PageServerLoad } from "./$types";
export const load: PageServerLoad = ({ locals }) => ({ username: locals.owner });
export const actions = {
	signout: async ({ locals, cookies }) => {
		const { access, cookieName, origin } = locals.studio;
		await access.signOut(cookies.get(cookieName));
		cookies.delete(cookieName, { path: "/", secure: origin.protocol === "https:" });
		redirect(303, "/sign-in");
	},
} satisfies Actions;
