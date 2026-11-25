import { error } from "@sveltejs/kit";
import { mediaHeaders } from "#lib/server/http/security-headers.ts";
import { videoResponse } from "#lib/server/services/gallery/video-response.ts";
import { mediaFileName } from "#lib/shared/gallery/file-name.ts";
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
	if (video) return videoResponse(request, url, video, mediaFileName(params.jobId, "video/mp4"));
	const image = await locals.studio.gallery.read(params.jobId);
	if (!image) error(404, "The saved file is unavailable.");
	return new Response(request.method === "HEAD" ? null : image.bytes, {
		headers: {
			...mediaHeaders("image"),
			"content-type": image.mime,
			"content-disposition":
				url.searchParams.get("download") === "1"
					? `attachment; filename="${mediaFileName(params.jobId, image.mime)}"`
					: "inline",
		},
	});
};

export const HEAD = GET;
