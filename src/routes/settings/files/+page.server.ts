import { error, fail, redirect } from "@sveltejs/kit";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ locals, url }) => {
	const setting = await locals.studio.cleaning.read().catch(() => null);
	if (!setting) error(503, "The attached-file setting is unavailable.");
	return { ...setting, offer: url.searchParams.has("offer") };
};

export const actions = {
	default: async ({ locals, request, url }) => {
		const data = await request.formData();
		const expected = Number(data.get("expectedRevision"));
		if (!Number.isSafeInteger(expected) || expected < 0)
			error(400, "Reload Settings and try again.");
		const enabled = data.get("enabled") === "on";
		const result = await locals.studio.cleaning.set(enabled, expected).catch(() => null);
		if (!result) return fail(503, { message: "Siluet could not save this setting. Try again." });
		const { saved, ...stored } = result;
		if (!saved) return fail(409, { ...stored, message: "Changed in another tab" });
		// A change retires every copy prepared under an earlier revision before anyone reviews it.
		if (stored.revision !== expected) await locals.studio.stages.retireAll(stored.revision);
		if (url.searchParams.has("offer")) redirect(303, "/");
		return { ...stored, message: "Saved." };
	},
} satisfies Actions;
