import { error, fail } from "@sveltejs/kit";
import { AccessError, CandidateRetry } from "#lib/server/services/owner/access-error.ts";
import { formField } from "#lib/server/services/owner/form.ts";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ locals, url }) => {
	if (!locals.session) error(401);
	const requested = url.searchParams.get("resume") ?? undefined;
	return {
		...(await locals.studio.access.security.settings(locals.session.digest, requested)),
		offer: url.searchParams.has("offer"),
	};
};
export const actions = {
	default: async ({ locals, request, setHeaders }) => {
		const { access } = locals.studio;
		const form = await request.formData(),
			field = (k: string) => formField(form, k);
		const session = locals.session?.digest ?? "",
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
			if (proof && action !== "enable" && action !== "replace")
				throw new AccessError("Restart authorization.", 403);
			const result =
				proof && (action === "enable" || action === "replace")
					? {
							kind: "changed" as const,
							...(await access.security.activate(action, session, proof, field("code"))),
						}
					: await access.security.authorize(action, session, field("password"), field("code"));
			if (result.kind === "candidate") return result;
			// The successor's bearer travels in a header the client strips before the form sees it.
			setHeaders({ "x-siluet-bearer": result.bearer });
			return { kind: "changed" as const, sessionId: result.sessionId, codes: result.codes };
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
