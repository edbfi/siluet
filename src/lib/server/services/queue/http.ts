import { json, type RequestEvent } from "@sveltejs/kit";
import { parseDerivedRequest } from "./derived";
import { parseQueueRequest } from "./request";

export async function queueAction(
	{ request, locals }: RequestEvent,
	operation: "review" | "submit",
) {
	if (!locals.owner) return json({ error: "unauthorized" }, { status: 401 });
	if (request.headers.get("content-type")?.split(";")[0].trim() !== "application/json")
		return json({ error: "invalid" }, { status: 415 });
	const value = await request.json().catch(() => null);
	// Released operations parse first; any other Poyo.ai text-to-image key is a derived row.
	const input = parseQueueRequest(value, operation) ?? parseDerivedRequest(value, operation);
	if (!input) return json({ error: "invalid" }, { status: 400 });
	const result = await locals.studio.queue[operation](locals.owner, input);
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
