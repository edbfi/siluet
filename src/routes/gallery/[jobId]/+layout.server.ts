import { error } from "@sveltejs/kit";
import type { LayoutServerLoad } from "./$types";

export const load: LayoutServerLoad = async ({ locals, params }) => {
	const image = await locals.studio.gallery.get(params.jobId);
	if (!image) error(404, "This image is no longer in Gallery.");
	return { image };
};
