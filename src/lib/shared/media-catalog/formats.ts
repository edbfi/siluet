// Which output formats a row offers, from its evidence alone. Nothing here reads a projection:
// the browser's reader of the Poyo.ai formats projection is ./poyo-formats.ts.

/**
 * A model's documented output-format option: the values its schema accepts and its effective
 * default, when that is resolved.
 */
export type FormatEvidence = { readonly values: readonly string[]; readonly default?: string };
/** An output-format option the deriver could not offer, with its reason. */
export type PendingFormat = { readonly pending: string };
/** A derived Poyo.ai image row in the formats projection. No `output_format`: no option. */
export type FormatRow = {
	model: string;
	output_format?: { values: string[]; default?: string } | { pending: string };
};
/**
 * What the composer offers and preselects: nothing when the model has no format option, a reason
 * when it has one Siluet cannot offer, and otherwise at least one offered format.
 */
export type OutputFormats =
	| { readonly state: "none" }
	| { readonly state: "unsavable"; readonly reason: string }
	| { readonly state: "offered"; readonly values: readonly string[]; readonly preselected: string };

// The wire values that request a type Gallery verifies and saves (D5: PNG, JPEG, still WebP).
// Matched exactly, so `jpg` stays `jpg`. `gif` is never offered: Gallery holds it.
const galleryTypes = {
	png: { type: "image/png", name: "PNG" },
	jpeg: { type: "image/jpeg", name: "JPEG" },
	jpg: { type: "image/jpeg", name: "JPEG" },
	webp: { type: "image/webp", name: "WebP" },
} as const;
type GalleryFormat = keyof typeof galleryTypes;
const saved = (value: string): value is GalleryFormat => Object.hasOwn(galleryTypes, value);

/**
 * The formats a row offers: its schema's values that Gallery saves, in schema order and sent
 * verbatim. The effective default is preselected when Gallery saves it. Otherwise, as for any
 * unresolved default, the composer preselects the first offered format and sends it.
 */
export function offeredFormats(
	evidence: FormatEvidence | PendingFormat | undefined,
): OutputFormats {
	if (!evidence) return { state: "none" };
	if ("pending" in evidence) return { state: "unsavable", reason: evidence.pending };
	const values = evidence.values.filter(saved);
	const [fallback] = values;
	if (fallback === undefined)
		return { state: "unsavable", reason: "Gallery saves none of its output formats" };
	const preselected =
		evidence.default !== undefined && values.includes(evidence.default as GalleryFormat)
			? evidence.default
			: fallback;
	return { state: "offered", values, preselected };
}

export type ExpectedImageType = {
	format: string;
	type: (typeof galleryTypes)[GalleryFormat]["type"];
	name: string;
};

/**
 * The type Review expects from the format a request sends. Without one, the provider chooses,
 * and Save records whatever type it verifies.
 */
export function expectedImageType(format: string | undefined): ExpectedImageType | null {
	if (format === undefined) return null;
	if (!saved(format)) throw new Error(`Gallery does not save ${format}.`);
	return { format, ...galleryTypes[format] };
}
