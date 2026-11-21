import { fail, type RequestEvent, redirect } from "@sveltejs/kit";
import { signOutNoticeName } from "#lib/shared/owner/session-notice.ts";
import { AccessError } from "./access";

export async function authenticate(event: RequestEvent, claim: boolean) {
	const { access, origin, cookieName } = event.locals.studio;
	const data = await event.request.formData();
	const field = (key: string) => {
		const value = data.get(key);
		return typeof value === "string" ? value : "";
	};
	try {
		const session = claim
			? await access.claim(field("token"), field("username"), field("password"))
			: await access.signIn(field("username"), field("password"));
		const secure = origin.protocol === "https:";
		event.cookies.set(cookieName, session, {
			path: "/",
			sameSite: "lax",
			httpOnly: true,
			secure,
			maxAge: 30 * 86400,
		});
		event.cookies.delete(signOutNoticeName(origin), { path: "/", secure });
	} catch (error) {
		if (error instanceof AccessError) {
			const username = field("username");
			const retain =
				username.length <= 128 && username !== field("password") && username !== field("token");
			return fail(error.status, { message: error.message, username: retain ? username : "" });
		}
		throw error;
	}
	redirect(303, "/");
}
