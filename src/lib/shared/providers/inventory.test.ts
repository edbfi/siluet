import { expect, test } from "bun:test";
import { accessText, type ModelAccess, rateLimitText } from "./inventory";

const at = Date.UTC(2026, 10, 28, 9, 30, 5);
const access = (state: ModelAccess["state"], extra: Partial<ModelAccess> = {}): ModelAccess => ({
	state,
	revision: 1,
	checkedAt: at,
	basis: "snapshot",
	...extra,
});

test.each([
	[access("listed"), "ToAPIs listed doubao-seedream-5-5 for this key at 2026-11-28 09:30:05 UTC."],
	[
		access("absent"),
		"ToAPIs did not list doubao-seedream-5-5 for this key at 2026-11-28 09:30:05 UTC.",
	],
	[
		access("failed", { failure: "rejected" }),
		"The ToAPIs model check failed at 2026-11-28 09:30:05 UTC (key refused). Check again.",
	],
	[
		access("failed", { failure: "unavailable" }),
		"The ToAPIs model check failed at 2026-11-28 09:30:05 UTC (service unavailable). Check again.",
	],
	[access("stale"), "The ToAPIs model list is more than 24 hours old. Check again."],
	[access("unchecked", { checkedAt: null }), "Check ToAPIs model access."],
	[
		access("disconnected", { checkedAt: null, revision: null }),
		"Connect a readable ToAPIs model key in Settings.",
	],
	[
		access("exception", { checkedAt: null, basis: "pre-snapshot" }),
		"The global image model list included this model for this key.",
	],
] as const)("Review and Settings say what the evidence says", (state, text) => {
	expect(accessText(state, "doubao-seedream-5-5", "image")).toBe(text);
});

test("the video exception keeps today's text, and a refused check says when to try again", () => {
	expect(accessText(access("exception", { checkedAt: null }), "seedance-2-5", "video")).toBe(
		"Seedance 2.5 was listed for this key.",
	);
	expect(rateLimitText(41.2)).toBe("Three checks a minute per scope. Try again in 42 s.");
});
