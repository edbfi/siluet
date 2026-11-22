import { json, type RequestEvent } from "@sveltejs/kit";
import { parseVideo } from "../../../shared/video-studio/seedance";
export async function videoAction({ request, locals }: RequestEvent, action: "review" | "submit") {
	if (!locals.owner) return json({ error: "unauthorized" }, { status: 401 });
	if (request.headers.get("content-type")?.split(";")[0].trim() !== "application/json")
		return json({ error: "invalid" }, { status: 415 });
	const input = parseVideo(await request.json().catch(() => null));
	if (!input) return json({ error: "invalid" }, { status: 400 });
	const result = await locals.studio.videoQueue[action](locals.owner, input);
	return json(result, {
		status:
			"error" in result
				? result.error === "cooldown"
					? 429
					: result.error === "stale"
						? 409
						: 400
				: 200,
	});
}
