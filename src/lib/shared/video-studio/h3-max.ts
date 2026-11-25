import type { PoyoVideoDescriptor } from "./poyo-video";
import type { SaveLimit } from "./save-profile";

// https://docs.poyo.ai/api-manual/video-series/h3-max.md
// Siluet offers 5–10 s at 480p or 768p and the six fixed ratios. 11–15 s, 1080p, `adaptive`,
// frame and reference inputs and `callback_url` are pending qualification.
// Save limit, same page (2026-11-24): "`duration` is an integer from 5 through 15 seconds; the
// default is 5."
const save = { seconds: 15, basis: "provider" } as SaveLimit | null;

export const h3Max = {
	model: "h3-max",
	label: "H3 Max",
	family: "MiniMax / Hailuo",
	operation: "text-to-video",
	defaults: { duration: 5, resolution: "768p", aspect_ratio: "16:9" },
	fields: {
		duration: { kind: "int", min: 5, max: 10 },
		resolution: { kind: "enum", values: ["480p", "768p"] },
		aspect_ratio: { kind: "enum", values: ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"] },
	},
	d4Field: "enable_safety_checker",
	disclosures: [
		"One potentially billable submission sends your prompt to Poyo.ai. Your balance check confirms account access. H3 Max access for this key is unverified.",
		"Poyo may charge a different amount from the public estimate. Save promptly. Content is available for three days after creation and a file link can expire after 24 hours.",
	],
	save,
	rateKey: "h3-max",
} as const satisfies PoyoVideoDescriptor;
