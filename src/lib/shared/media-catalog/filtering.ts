// D4: the fixed filtering field on media requests (docs/decisions.md#d4, and the catalog engine
// spec's "D4 by catalog and REST evidence"). Siluet sends `false` on every model unless a
// published schema forbids the field. Each row takes one state, derived mechanically from the
// pinned catalog schema and the model's OpenAPI input.

export const d4States = [
	"declared",
	"closed-absent",
	"open-absent",
	"open-absent-fixed",
	"contradiction",
	"refused",
	"unknown",
] as const;
export type D4State = (typeof d4States)[number];

/** Which published schemas close the input without the field. */
export type ClosingSource = "api" | "catalog" | "both";

/** `catalogOnly` marks a Poyo.ai row with no OpenAPI spec, whose state is the catalog's alone. */
export type FilteringEvidence = (
	| { readonly d4: "declared" | "contradiction" | "refused" | "unknown" }
	| { readonly d4: "closed-absent"; readonly closedBy: ClosingSource }
	| { readonly d4: "open-absent" | "open-absent-fixed" }
) & { readonly catalogOnly?: true };

export type CatalogSide = "declared" | "closed" | "open";
/** The model's OpenAPI input. `fixed` needs a reviewed quote that filtering is fixed. */
export type RestSide = "declared" | "closed" | "fixed" | "open" | "none";

// Rows: the pinned catalog. Columns: the REST input. A closed REST input takes the closed
// column even when the page also says filtering is fixed.
const table: Record<CatalogSide, Record<RestSide, D4State>> = {
	declared: {
		declared: "declared",
		closed: "contradiction",
		fixed: "contradiction",
		open: "declared",
		none: "declared",
	},
	closed: {
		declared: "contradiction",
		closed: "closed-absent",
		fixed: "closed-absent",
		open: "closed-absent",
		none: "closed-absent",
	},
	open: {
		declared: "declared",
		closed: "closed-absent",
		fixed: "open-absent-fixed",
		open: "open-absent",
		none: "open-absent",
	},
};

/** The D4 cell for one Poyo.ai row. The stricter published schema wins (engine ruling). */
export function d4Cell(catalog: CatalogSide, rest: RestSide): FilteringEvidence {
	const d4 = table[catalog][rest];
	const source = rest === "none" ? ({ catalogOnly: true } as const) : {};
	if (d4 !== "closed-absent") return { d4, ...source } as FilteringEvidence;
	const closedBy =
		catalog === "closed" && rest === "closed" ? "both" : catalog === "closed" ? "catalog" : "api";
	return { d4, closedBy, ...source };
}

const providerNames = { poyo: "Poyo.ai", toapis: "ToAPIs" } as const;
export const filteringFields = { poyo: "enable_safety_checker", toapis: "disable_nsfw" } as const;
export type FilteringProvider = keyof typeof filteringFields;

const closingSources: Record<ClosingSource, string> = {
	api: "Poyo.ai's API schema for this model has no enable_safety_checker field and allows no fields it does not list",
	catalog:
		"Poyo.ai's catalog schema for this model has no enable_safety_checker field and allows no fields it does not list",
	both: "Poyo.ai's catalog and API schemas for this model have no enable_safety_checker field and allow no fields they do not list",
};

/** The acknowledgement a closed-absent Review binds. */
export function d4Acknowledgement(closedBy: ClosingSource) {
	return `${closingSources[closedBy]}, so Siluet sends this request without it. Filtering is up to Poyo.ai. I understand.`;
}

/** The disclosure an open-absent Review binds; `fixed` when the API page says filtering is fixed. */
export function d4Disclosure(provider: FilteringProvider, fixed = false) {
	const name = providerNames[provider];
	const field = filteringFields[provider];
	const opening = fixed
		? `${name}'s API page says filtering for this model is fixed.`
		: `${name} does not document ${field} for this model.`;
	return `${opening} Siluet sends ${field}: false anyway. Whether ${name} accepts it or applies it is unverified. If ${name} rejects the request, Siluet does not resend it without the field.`;
}

export const catalogOnlyNote =
	"Siluet read this from Poyo.ai's catalog. This model's API page was not reviewed.";

/** Shown separately on a ToAPIs row whose page documents a conditional fallback. */
export const toapisFallbackNote =
	"ToAPIs says disable_nsfw: false enables its fallback only for eligible accounts and regions. Siluet cannot check whether this key is eligible.";

/** The wording a Review must bind before Queue accepts this state, or null when none can. */
export function d4Wording(provider: FilteringProvider, evidence: FilteringEvidence) {
	const wording =
		evidence.d4 === "closed-absent"
			? provider === "poyo"
				? d4Acknowledgement(evidence.closedBy)
				: null
			: evidence.d4 === "open-absent" || evidence.d4 === "open-absent-fixed"
				? d4Disclosure(provider, evidence.d4 === "open-absent-fixed")
				: evidence.d4 === "declared"
					? ""
					: null;
	if (wording === null) return null;
	return [...(wording ? [wording] : []), ...(evidence.catalogOnly ? [catalogOnlyNote] : [])];
}

/**
 * Why Queue is blocked by D4, or null. Contradiction, refused and unknown always block.
 * Closed-absent needs its acknowledgement and open-absent its disclosure among the wording the
 * Review bound, and a catalog-only row also its unreviewed-page sentence. Image and file Reviews
 * bind no D4 wording yet, so there only a declared row with an OpenAPI spec can queue.
 */
export function queueEvidenceProblem(
	evidence: FilteringEvidence,
	provider: FilteringProvider,
	bound: readonly string[] = [],
) {
	switch (evidence.d4) {
		case "contradiction":
			return "Queue is unavailable because the filtering flag conflicts with the provider contract.";
		case "refused":
			return "Queue is unavailable because the provider refuses the filtering flag.";
		case "unknown":
			return "Queue requires confirmation that the provider accepts the filtering flag.";
	}
	const wording = d4Wording(provider, evidence);
	if (!wording)
		return "Queue is unavailable because this provider's filtering evidence has no reviewed wording.";
	if (wording.every((part) => bound.includes(part))) return null;
	return evidence.d4 === "closed-absent"
		? `Queue needs your acknowledgement that Siluet sends this request without ${filteringFields[provider]}.`
		: "Queue needs Review to show how Siluet handles the filtering flag for this model.";
}

/** Only a declared row's route-evidence note says the model contract declares the field. */
export const contractDeclaresField = (evidence: FilteringEvidence) => evidence.d4 === "declared";
