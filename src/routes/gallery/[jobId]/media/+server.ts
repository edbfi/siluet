import { error } from "@sveltejs/kit";
import { imageHead, imageResponse } from "#lib/server/services/gallery/image-response.ts";
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
	const { gallery } = locals.studio;
	const head = request.method === "HEAD";
	const video = await gallery.openVideo(params.jobId, head);
	if (video) return videoResponse(request, url, video, mediaFileName(params.jobId, "video/mp4"));
	if (head) {
		const image = await gallery.headImage(params.jobId);
		if (!image) error(404, "The saved file is unavailable.");
		return imageHead(image, url, mediaFileName(params.jobId, image.mime));
	}
	// A request that ends while it waits for a read permit leaves the queue.
	const image = await gallery.openImage(params.jobId, request.signal).catch((cause: unknown) => {
		if (request.signal.aborted) error(503, "The request ended before the file was read.");
		throw cause;
	});
	if (!image) error(404, "The saved file is unavailable.");
	return imageResponse(image, url, mediaFileName(params.jobId, image.mime));
};

export const HEAD = GET;
