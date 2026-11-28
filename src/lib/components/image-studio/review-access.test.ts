import { expect, test } from "bun:test";
import { reviewAccess } from "./review-access";

const listed = {
	state: "listed",
	text: "ToAPIs listed doubao-seedream-5-5 for this key at 2026-11-28 09:30:00 UTC.",
};
const absent = {
	state: "absent",
	text: "ToAPIs did not list doubao-seedream-5-5 for this key at 2026-11-28 09:30:00 UTC.",
};

test.each([
	["listed", { access: listed, blockers: [] }, listed.text, false],
	["absent", { access: absent, blockers: [absent.text] }, absent.text, true],
	[
		"unchecked",
		{
			access: { state: "unchecked", text: "Check ToAPIs model access." },
			blockers: ["Check ToAPIs model access."],
		},
		"Check ToAPIs model access.",
		true,
	],
	[
		"skipped",
		{
			access: { state: "stale", text: "Siluet could not reach ToAPIs. Nothing was recorded." },
			blockers: ["Siluet could not reach ToAPIs. Nothing was recorded."],
		},
		"Siluet could not reach ToAPIs. Nothing was recorded.",
		true,
	],
] as const)(
	"a %s Review shows its access line once and blocks Queue only with a blocker",
	(_, terms, line, blocked) => {
		const shown = reviewAccess(terms);
		expect(shown.line).toBe(line);
		expect(shown.blocked).toBe(blocked);
		// The access line leaves the listed blockers, so its text appears once.
		expect(shown.blockers).toEqual([]);
	},
);

test("a Poyo.ai or derived Review has no access line or blocker", () => {
	expect(reviewAccess({})).toEqual({ line: null, blocked: false, blockers: [] });
	expect(reviewAccess(null)).toEqual({ line: null, blocked: false, blockers: [] });
});

test("another blocker stays listed and blocks Queue", () => {
	expect(reviewAccess({ access: listed, blockers: ["Another reason."] })).toEqual({
		line: listed.text,
		blocked: true,
		blockers: ["Another reason."],
	});
});
