import { fail, type RequestEvent, redirect } from "@sveltejs/kit";
import { AccessError } from "./access-error";
import { clearPendingCredential, pendingCredential, setCredential } from "./cookies";
export function formField(data: FormData, key: string) {
	const value = data.get(key);
	return typeof value === "string" ? value : "";
}
export async function authenticate(event: RequestEvent, claim: boolean) {
	const { access, origin, cookieName } = event.locals.studio;
	const data = await event.request.formData(),
		field = (key: string) => formField(data, key);
	const previous = pendingCredential(event.cookies, cookieName);
	let target = "/";
	try {
		if (claim) {
			const session = await access.claim(field("token"), field("username"), field("password"));
			setCredential(event.cookies, cookieName, session, origin);
			target = "/settings/security?offer";
		} else if (field("action") === "cancel") {
			await access.security.cancel(previous);
			clearPendingCredential(event.cookies, cookieName, previous, origin);
			target = "/sign-in";
		} else if (field("action") === "factor") {
			const session = await access.security.complete(previous, field("code"));
			clearPendingCredential(event.cookies, cookieName, previous, origin);
			setCredential(event.cookies, cookieName, session, origin);
		} else {
			const result = await access.signIn(field("username"), field("password"), previous);
			clearPendingCredential(event.cookies, cookieName, previous, origin);
			setCredential(event.cookies, cookieName, result.token, origin, result.kind === "pending");
			if (result.kind === "pending") target = "/sign-in";
		}
	} catch (e) {
		if (e instanceof AccessError) {
			const username = field("username");
			return fail(e.status, {
				message: e.message,
				username:
					username.length <= 128 &&
					username !== field("password") &&
					username !== field("token") &&
					username !== field("code")
						? username
						: "",
			});
		}
		throw e;
	}
	redirect(303, target);
}
