import { json, type RequestEvent } from "@sveltejs/kit";
import {
	disconnectedText,
	inventoryScopes,
	rateLimitText,
} from "../../../shared/providers/inventory";

/** Check again for one scope: owner-authenticated and same-origin JSON, for Settings and Reviews. */
export async function inventoryAction({ request, locals }: RequestEvent) {
	if (!locals.owner) return json({ error: "unauthorized" }, { status: 401 });
	if (request.headers.get("origin") !== locals.studio.origin.origin)
		return json({ error: "forbidden" }, { status: 403 });
	if (request.headers.get("content-type")?.split(";")[0].trim() !== "application/json")
		return json({ error: "invalid" }, { status: 415 });
	const body: unknown = await request.json().catch(() => null);
	const scope = inventoryScopes.find(
		(candidate) =>
			typeof body === "object" && body !== null && "scope" in body && body.scope === candidate,
	);
	if (!scope) return json({ error: "invalid" }, { status: 400 });
	const checked = await locals.studio.inventory.check(scope);
	switch (checked.outcome) {
		case "recorded": {
			const section = await locals.studio.inventorySection(scope);
			return json({
				outcome: checked.outcome,
				ok: checked.result === "succeeded",
				message: section.line,
				section,
			});
		}
		case "rate-limited":
			return json(
				{ outcome: checked.outcome, ok: false, message: rateLimitText(checked.retryAfter) },
				{ status: 429 },
			);
		case "disconnected":
			return json(
				{ outcome: checked.outcome, ok: false, message: disconnectedText },
				{ status: 409 },
			);
		default:
			// A manual check never skips; anything else changed under it and recorded nothing.
			return json(
				{
					outcome: "superseded",
					ok: false,
					message: "A newer check or a key change replaced this one. Check again.",
				},
				{ status: 409 },
			);
	}
}
