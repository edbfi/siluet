// Reviewed rules and overrides, each bound to the SHA-256 of the canonical schema it was checked
// against. A changed schema makes it stale: the construct it replaced is uncovered again, and
// the override no longer narrows the row. Overrides may only narrow.
import type { Body, ReviewedRule } from "./schema";

const ratios = ["1:1", "4:3", "3:4", "16:9", "9:16", "3:2", "2:3"];
const tier = (longEdge: number) => (longEdge <= 1024 ? "1K" : longEdge <= 2048 ? "2K" : "4K");

/**
 * flux-3-klein `size`: exactly `oneOf` [an enum of seven ratios, `pattern: ^\d+x\d+$`]. Siluet
 * sends canonical `WxH`. Catalog `ec73207`, unchanged since `747e5d7`: "Custom dimensions must
 * each be 256-4096, divisible by 16, and accompanied by an explicit matching resolution";
 * `resolution`: "For custom dimensions, the long edge selects the tier: at most 1024 = 1K,
 * above 1024 through 2048 = 2K, above 2048 through 4096 = 4K."
 */
function fluxKleinSize(value: unknown, body: Body) {
	if (typeof value !== "string") return "must be a string";
	if (ratios.includes(value)) return null;
	const match = /^(\d+)x(\d+)$/.exec(value);
	if (!match) return "is neither a listed ratio nor WIDTHxHEIGHT";
	// Siluet sends canonical WxH only.
	if (/^0|x0/.test(value)) return "has a side with a leading zero";
	const [width, height] = [Number(match[1]), Number(match[2])];
	if ([width, height].some((side) => side < 256 || side > 4096))
		return "has a side outside 256-4096";
	if ([width, height].some((side) => side % 16)) return "has a side not divisible by 16";
	if (body.resolution !== tier(Math.max(width, height)))
		return `needs resolution ${tier(Math.max(width, height))}`;
	return null;
}

const fluxKleinQuote =
	"Custom dimensions must each be 256-4096, divisible by 16, and accompanied by an explicit matching resolution.";

// The OpenAPI input's `size` is a `oneOf` of the same ratios and a described WIDTHxHEIGHT
// branch, with the same sentence, so the rule replaces both sources' constructs.
const fluxKlein = (
	model: string,
	source: "catalog" | "rest",
	schemaSha256: string,
): ReviewedRule => ({
	id: `${model}-size-${source}`,
	model,
	source,
	schemaSha256,
	field: "size",
	constructs: ["oneOf"],
	quote: fluxKleinQuote,
	check: fluxKleinSize,
});

export const reviewedRules: readonly ReviewedRule[] = [
	fluxKlein(
		"flux-3-klein",
		"catalog",
		"6b2cc771fdd5b78bc6d461bf3fa7c33fd3414d3843046d43554b4aeb8224593e",
	),
	fluxKlein(
		"flux-3-klein",
		"rest",
		"d0a89b2f6d4267e2016874ea9216bd38a51603beef3eea29cb3bc297e4cfb0c5",
	),
	fluxKlein(
		"flux-3-klein-edit",
		"catalog",
		"d9cc07c5812aa2771d9804ef771e0608172db1a5acfcf77ca2883bfe5320ce57",
	),
	fluxKlein(
		"flux-3-klein-edit",
		"rest",
		"100d9e6596b34decbca5f04ef3481b341841fef3ca946b2aabbcd3b5a3f9c2c4",
	),
];

/** A reviewed narrowing of one option's documented domain on one operation. */
export type ReviewedOverride = {
	readonly model: string;
	readonly operation: string;
	readonly field: string;
	readonly schemaSha256: string;
	/** Values removed from the documented domain, because the provider says they do not apply. */
	readonly excludes: readonly unknown[];
	readonly quote: string;
};

export const reviewedOverrides: readonly ReviewedOverride[] = [
	{
		model: "seedream-5.5",
		operation: "text-to-image",
		field: "size",
		schemaSha256: "5aed72c999e5a0e16e6755d6c0e1df2660c2ef363cd3fdd10913c96741edda44",
		excludes: ["auto"],
		quote: "auto applies to image editing and follows the reference images",
	},
	{
		model: "h3-max",
		operation: "text-to-video",
		field: "aspect_ratio",
		schemaSha256: "a6ed2d836a9301a26981500d1632c33c902732776f8e24cb692f09c61f02b3d4",
		excludes: ["adaptive"],
		quote: "Text mode defaults to 16:9 and does not accept adaptive.",
	},
];

/** Where a one-output quote stands, bound to the digest of the source it was read from. */
export type OutputSource =
	/** The model's OpenAPI spec's `info.description`, at the spec's manifest SHA-256. */
	| { readonly kind: "openapi-info"; readonly spec: string; readonly sha256: string }
	/** A model page recorded in page-reviews.json, at its Markdown SHA-256. */
	| { readonly kind: "page"; readonly url: string; readonly sha256: string };

/**
 * Evidence that one mode of a row without a count field returns one output (spec, "One output
 * per request"). The quote must stand in its bound source; a changed digest makes the note stale.
 */
export type OutputNote = {
	readonly model: string;
	readonly operation: string;
	readonly quote: string;
	readonly source: OutputSource;
};

const openapiInfo = (path: string, sha256: string) =>
	({ kind: "openapi-info", spec: `/api-manual/image-series/${path}.json`, sha256 }) as const;

// The eleven rows the G4 plan lists as conditional on their model page stay without a note:
// the two pinned pages (seedream-5.0-pro, nano-banana-2-lite) state no output count, and the
// other nine pages are not pinned (page-reviews.json).
export const outputNotes: readonly OutputNote[] = [
	{
		model: "qwen-image-2.1",
		operation: "text-to-image",
		quote: "The Qwen Image 2.1 API generates one image from text",
		source: openapiInfo(
			"qwen-image-2-1",
			"93a072aed810078eac0fc927c7a81298bacfdeaaeaba51e512dff6380d6919aa",
		),
	},
	{
		model: "seedream-5.0-flash",
		operation: "text-to-image",
		quote: "The Seedream 5.0 Flash API generates one image from text",
		source: openapiInfo(
			"seedream-5-0-flash",
			"767b459336c42f30a351e70ec65fbb3a0e0536f4bc147e953416b48dabab2e1b",
		),
	},
];
