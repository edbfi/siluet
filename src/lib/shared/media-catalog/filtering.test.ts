import { expect, test } from "bun:test";
import {
	type CatalogSide,
	catalogOnlyNote,
	contractDeclaresField,
	d4Acknowledgement,
	d4Cell,
	d4Disclosure,
	d4Wording,
	type FilteringEvidence,
	queueEvidenceProblem,
	type RestSide,
} from "./filtering";

const cells: [CatalogSide, RestSide, FilteringEvidence][] = [
	["declared", "declared", { d4: "declared" }],
	["declared", "closed", { d4: "contradiction" }],
	["declared", "fixed", { d4: "contradiction" }],
	["declared", "open", { d4: "declared" }],
	["declared", "none", { d4: "declared", catalogOnly: true }],
	["closed", "declared", { d4: "contradiction" }],
	["closed", "closed", { d4: "closed-absent", closedBy: "both" }],
	["closed", "fixed", { d4: "closed-absent", closedBy: "catalog" }],
	["closed", "open", { d4: "closed-absent", closedBy: "catalog" }],
	["closed", "none", { d4: "closed-absent", closedBy: "catalog", catalogOnly: true }],
	["open", "declared", { d4: "declared" }],
	["open", "closed", { d4: "closed-absent", closedBy: "api" }],
	["open", "fixed", { d4: "open-absent-fixed" }],
	["open", "open", { d4: "open-absent" }],
	["open", "none", { d4: "open-absent", catalogOnly: true }],
];

test.each(cells)("catalog %s with REST %s takes its table cell", (catalog, rest, expected) => {
	expect(d4Cell(catalog, rest)).toEqual(expected);
});

test("a closed REST input that also says filtering is fixed takes the closed column", () => {
	// The REST side is `closed` whenever the input is closed, so `fixed` never reaches a closed
	// input; the open catalog row then reads closed-absent, never fixed.
	expect(d4Cell("open", "closed").d4).toBe("closed-absent");
});

test("the acknowledgement names the source that closes the input", () => {
	expect(d4Acknowledgement("api")).toBe(
		"Poyo.ai's API schema for this model has no enable_safety_checker field and allows no fields it does not list, so Siluet sends this request without it. Filtering is up to Poyo.ai. I understand.",
	);
	expect(d4Acknowledgement("catalog")).toStartWith("Poyo.ai's catalog schema for this model");
	expect(d4Acknowledgement("both")).toStartWith(
		"Poyo.ai's catalog and API schemas for this model have no enable_safety_checker field and allow no fields they do not list",
	);
});

test("the disclosures say acceptance and effect are unverified", () => {
	expect(d4Disclosure("poyo")).toBe(
		"Poyo.ai does not document enable_safety_checker for this model. Siluet sends enable_safety_checker: false anyway. Whether Poyo.ai accepts it or applies it is unverified. If Poyo.ai rejects the request, Siluet does not resend it without the field.",
	);
	expect(d4Disclosure("poyo", true)).toStartWith(
		"Poyo.ai's API page says filtering for this model is fixed. Siluet sends enable_safety_checker: false anyway.",
	);
	expect(d4Disclosure("toapis")).toBe(
		"ToAPIs does not document disable_nsfw for this model. Siluet sends disable_nsfw: false anyway. Whether ToAPIs accepts it or applies it is unverified. If ToAPIs rejects the request, Siluet does not resend it without the field.",
	);
});

const states: FilteringEvidence[] = [
	{ d4: "declared" },
	{ d4: "declared", catalogOnly: true },
	{ d4: "closed-absent", closedBy: "api" },
	{ d4: "closed-absent", closedBy: "catalog" },
	{ d4: "closed-absent", closedBy: "both" },
	{ d4: "open-absent" },
	{ d4: "open-absent", catalogOnly: true },
	{ d4: "open-absent-fixed" },
	{ d4: "contradiction" },
	{ d4: "refused" },
	{ d4: "unknown" },
];

test.each(states)("the guard needs exactly the bound wording for %p", (evidence) => {
	for (const provider of ["poyo", "toapis"] as const) {
		const wording = d4Wording(provider, evidence);
		const blocking = ["contradiction", "refused", "unknown"].includes(evidence.d4);
		const toapisClosed = provider === "toapis" && evidence.d4 === "closed-absent";
		if (blocking || toapisClosed) {
			expect(queueEvidenceProblem(evidence, provider, wording ?? [])).toBeString();
			continue;
		}
		if (!wording) throw new Error("Expected wording for a queueing state.");
		expect(queueEvidenceProblem(evidence, provider, wording)).toBeNull();
		expect(queueEvidenceProblem(evidence, provider, [...wording, "unrelated"])).toBeNull();
		// Without its wording, or with changed wording, a queueing state other than a declared
		// row with a reviewed API page blocks.
		const unbound = queueEvidenceProblem(evidence, provider);
		const changed = queueEvidenceProblem(
			evidence,
			provider,
			wording.map((part) => `${part} `),
		);
		if (wording.length) {
			expect(unbound).toBeString();
			expect(changed).toBeString();
		} else {
			expect(unbound).toBeNull();
			expect(changed).toBeNull();
		}
	}
});

test("a catalog-only row binds the unreviewed-page sentence with its state", () => {
	expect(d4Wording("poyo", { d4: "declared", catalogOnly: true })).toEqual([catalogOnlyNote]);
	expect(d4Wording("poyo", { d4: "open-absent", catalogOnly: true })).toEqual([
		d4Disclosure("poyo"),
		catalogOnlyNote,
	]);
	expect(catalogOnlyNote).toBe(
		"Siluet read this from Poyo.ai's catalog. This model's API page was not reviewed.",
	);
});

test("only a declared row's note says the contract declares the field", () => {
	expect(states.filter(contractDeclaresField).map(({ d4 }) => d4)).toEqual([
		"declared",
		"declared",
	]);
});
