import { fail, type RequestEvent, redirect } from "@sveltejs/kit";
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
		event.cookies.set(cookieName, session, {
			path: "/",
			sameSite: "lax",
			httpOnly: true,
			secure: origin.protocol === "https:",
			maxAge: 30 * 86400,
		});
	} catch (error) {
		if (error instanceof AccessError) return fail(error.status, { message: error.message });
		throw error;
	}
	redirect(303, "/");
}
