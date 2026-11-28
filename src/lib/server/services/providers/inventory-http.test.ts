import { expect, test } from "bun:test";
import type { RequestEvent } from "@sveltejs/kit";
import type { InventoryCheck } from "./inventory";
import { inventoryAction } from "./inventory-http";

const origin = "http://127.0.0.1:4173";

function event(
	body: unknown,
	{ owner = "creator", from = origin, type = "application/json" } = {},
	outcome: InventoryCheck = {
		outcome: "recorded",
		result: "succeeded",
		checkedAt: Date.UTC(2026, 10, 28, 9, 30),
	},
) {
	const asked: unknown[] = [];
	const request = new Request(`${origin}/providers/inventory`, {
		method: "POST",
		headers: { "content-type": type, origin: from },
		body: JSON.stringify(body),
	});
	const studio = {
		origin: new URL(origin),
		inventory: {
			check: async (scope: string) => {
				asked.push(scope);
				return outcome;
			},
		},
		inventorySection: async (scope: string) => ({ scope, line: `section ${scope}` }),
	};
	return {
		asked,
		event: { request, locals: { owner: owner || undefined, studio } } as unknown as RequestEvent,
	};
}

test("Check again needs the signed-in owner on the studio's own origin", async () => {
	const anonymous = event({ scope: "image" }, { owner: "" });
	expect((await inventoryAction(anonymous.event)).status).toBe(401);
	const crossOrigin = event({ scope: "image" }, { from: "http://localhost:4444" });
	expect((await inventoryAction(crossOrigin.event)).status).toBe(403);
	const form = event({ scope: "image" }, { type: "application/x-www-form-urlencoded" });
	expect((await inventoryAction(form.event)).status).toBe(415);
	const unknown = event({ scope: "audio" });
	expect((await inventoryAction(unknown.event)).status).toBe(400);
	for (const refused of [anonymous, crossOrigin, form, unknown]) expect(refused.asked).toEqual([]);
});

test("a recorded check answers with its scope's refreshed section", async () => {
	const { event: request, asked } = event({ scope: "video" });
	const response = await inventoryAction(request);
	expect(response.status).toBe(200);
	expect(await response.json()).toEqual({
		outcome: "recorded",
		ok: true,
		message: "section video",
		section: { scope: "video", line: "section video" },
	});
	expect(asked).toEqual(["video"]);
});

test.each([
	[
		{ outcome: "rate-limited", retryAfter: 42 },
		429,
		"Three checks a minute per scope. Try again in 42 s.",
	],
	[{ outcome: "disconnected" }, 409, "Connect a readable ToAPIs model key in Settings."],
	[{ outcome: "superseded" }, 409, "A newer check or a key change replaced this one. Check again."],
] as const)("a refused check says why", async (outcome, status, message) => {
	const response = await inventoryAction(event({ scope: "image" }, {}, outcome).event);
	expect(response.status).toBe(status);
	expect(await response.json()).toMatchObject({ outcome: outcome.outcome, ok: false, message });
});

test("a recorded failure is an alert", async () => {
	const response = await inventoryAction(
		event({ scope: "image" }, {}, { outcome: "recorded", result: "unavailable", checkedAt: 1 })
			.event,
	);
	expect(await response.json()).toMatchObject({ outcome: "recorded", ok: false });
});
