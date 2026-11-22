import { json, type RequestEvent } from "@sveltejs/kit";
import { parseQueueRequest } from "./request";

export async function queueAction(
	{ request, locals }: RequestEvent,
	operation: "review" | "submit",
) {
	if (!locals.owner) return json({ error: "unauthorized" }, { status: 401 });
	if (request.headers.get("content-type")?.split(";")[0].trim() !== "application/json")
		return json({ error: "invalid" }, { status: 415 });
	const value = await request.json().catch(() => null);
	const input = parseQueueRequest(value, operation);
	if (!input) return json({ error: "invalid" }, { status: 400 });
	const result = await locals.studio.queue[operation](locals.owner, input);
	return json(result, { status: "error" in result ? (result.error === "stale" ? 409 : 400) : 200 });
}
