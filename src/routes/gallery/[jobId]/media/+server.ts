import { error } from "@sveltejs/kit";
import { mediaHeaders } from "#lib/server/http/security-headers.ts";
import { videoResponse } from "#lib/server/services/gallery/video-response.ts";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ locals, params, url, request }) => {
	const origin = request.headers.get("origin");
	const site = request.headers.get("sec-fetch-site");
	if (
		(origin !== null && origin !== locals.studio.origin.origin) ||
		(site !== null && !["same-origin", "none"].includes(site))
	)
		error(403, "Open the saved media from Gallery.");
	const video = await locals.studio.gallery.openVideo(params.jobId, request.method === "HEAD");
	// Downloads are named after the job, never after a provider or user-supplied name.
	const name = params.jobId.slice(0, 8).replace(/[^a-zA-Z0-9-]/g, "");
	if (video) return videoResponse(request, url, video, `siluet-video-${name}.mp4`);
	const image = await locals.studio.gallery.read(params.jobId);
	if (!image) error(404, "The saved file is unavailable.");
	const extension = image.mime === "image/png" ? "png" : "jpg";
	return new Response(request.method === "HEAD" ? null : image.bytes, {
		headers: {
			...mediaHeaders("image"),
			"content-type": image.mime,
			"content-disposition":
				url.searchParams.get("download") === "1"
					? `attachment; filename="siluet-image-${name}.${extension}"`
					: "inline",
		},
	});
};

export const HEAD = GET;
