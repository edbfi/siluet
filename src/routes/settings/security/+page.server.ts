import { fail } from "@sveltejs/kit";
import { AccessError, CandidateRetry } from "#lib/server/services/owner/access-error.ts";
import {
	candidateReceipt,
	securityNotice,
	setCredential,
} from "#lib/server/services/owner/cookies.ts";
import { formField } from "#lib/server/services/owner/form.ts";
import type { Actions, PageServerLoad } from "./$types";
export const load: PageServerLoad = async ({ locals, cookies, url }) => {
	const { access, cookieName, origin } = locals.studio;
	const session = cookies.get(cookieName) ?? "";
	const receipt = candidateReceipt(cookies, cookieName, session, origin);
	const requested = url.searchParams.has("resume");
	const present = receipt.present();
	return {
		...(await access.security.settings(session, requested && present ? receipt.get : undefined)),
		canResume: !requested && present,
		offer: url.searchParams.has("offer"),
		windows: process.platform === "win32",
	};
};
export const actions = {
	default: async ({ locals, cookies, request }) => {
		const { access, origin, cookieName } = locals.studio;
		const form = await request.formData(),
			field = (k: string) => formField(form, k);
		const session = cookies.get(cookieName) ?? "",
			action = field("change"),
			proof = field("proof");
		try {
			if (
				action !== "enable" &&
				action !== "replace" &&
				action !== "regenerate" &&
				action !== "disable"
			)
				throw new AccessError("Choose a Security action.", 400);
			let result: Awaited<ReturnType<typeof access.security.authorize>>;
			if (proof) {
				if (action !== "enable" && action !== "replace")
					throw new AccessError("Restart authorization.", 403);
				result = {
					kind: "changed" as const,
					...(await access.security.activate(action, session, proof, field("code"))),
				};
			} else
				result = await access.security.authorize(action, session, field("password"), field("code"));
			const receipt = candidateReceipt(cookies, cookieName, session, origin);
			if (result.kind === "candidate") {
				receipt.save(result.proof);
				return result;
			}
			if (proof) receipt.remove(proof);
			setCredential(cookies, cookieName, result.session, origin);
			cookies.set(...securityNotice(origin));
			return { kind: "changed" as const, codes: result.codes };
		} catch (e) {
			if (e instanceof AccessError)
				return fail(e.status, {
					kind: "error" as const,
					message: e.message,
					proof: e instanceof CandidateRetry ? e.proof : "",
					action: action === "enable" || action === "replace" ? action : null,
				});
			throw e;
		}
	},
} satisfies Actions;
