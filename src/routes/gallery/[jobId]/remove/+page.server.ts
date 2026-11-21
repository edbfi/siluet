import { fail, redirect } from "@sveltejs/kit";
import type { Actions } from "./$types";

export const actions = {
	default: async ({ locals, request, params }) => {
		if ((await request.formData()).get("confirm") !== "remove")
			return fail(400, { message: "Confirm removal of this image." });
		try {
			await locals.studio.gallery.remove(params.jobId);
		} catch {
			return fail(503, {
				message: "Removal could not finish. Check the installation directory and restart Siluet.",
			});
		}
		redirect(303, "/gallery");
	},
} satisfies Actions;
