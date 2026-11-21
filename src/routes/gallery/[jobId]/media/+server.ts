import { error } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ locals, params, url }) => {
	const image = await locals.studio.gallery.read(params.jobId);
	if (!image) error(404, "The saved image file is unavailable.");
	const extension = image.mime === "image/png" ? "png" : "jpg";
	return new Response(image.bytes, {
		headers: {
			"cache-control": "private, no-store",
			"content-type": image.mime,
			"x-content-type-options": "nosniff",
			"content-disposition":
				url.searchParams.get("download") === "1"
					? `attachment; filename="siluet-image.${extension}"`
					: "inline",
		},
	});
};
