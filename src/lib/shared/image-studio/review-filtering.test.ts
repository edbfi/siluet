import { expect, test } from "bun:test";
import { d4States, type FilteringEvidence, queueEvidenceProblem } from "../media-catalog/filtering";
import { imageReviewFiltering } from "./review-filtering";

const states: FilteringEvidence[] = [
	{ d4: "declared" },
	{ d4: "declared", catalogOnly: true },
	{ d4: "closed-absent", closedBy: "api" },
	{ d4: "closed-absent", closedBy: "catalog" },
	{ d4: "closed-absent", closedBy: "both" },
	{ d4: "open-absent" },
	{ d4: "open-absent-fixed" },
	{ d4: "contradiction" },
	{ d4: "refused" },
	{ d4: "unknown" },
];

test("the fixtures cover every D4 state", () => {
	expect([...new Set(states.map(({ d4 }) => d4))].sort()).toEqual([...d4States].sort());
});

test.each(["poyo", "toapis"] as const)(
	"%s image Review offers Queue only on a declared row with a spec, and says declares only when declared",
	(provider) => {
		for (const evidence of states) {
			const { unavailable, declaredField } = imageReviewFiltering(evidence, provider);
			// Image Reviews bind no D4 wording yet.
			expect(unavailable).toBe(queueEvidenceProblem(evidence, provider));
			expect(unavailable === null).toBe(evidence.d4 === "declared" && !evidence.catalogOnly);
			expect(declaredField).toBe(
				evidence.d4 === "declared"
					? provider === "poyo"
						? "input.enable_safety_checker"
						: "disable_nsfw"
					: null,
			);
		}
	},
);
