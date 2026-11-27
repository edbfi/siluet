import projection from "./poyo-formats.json";

/**
 * A model's documented output-format option: the values its schema accepts and its effective
 * default, when that is resolved.
 */
export type FormatEvidence = { readonly values: readonly string[]; readonly default?: string };
/** A derived Poyo.ai image row in the formats projection. No `output_format`: no option. */
export type FormatRow = { model: string; output_format?: { values: string[]; default?: string } };
/** What the composer offers and preselects. `preselected` is undefined when nothing is offered. */
export type OutputFormats = { readonly values: readonly string[]; readonly preselected?: string };

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
export function offeredFormats(evidence: FormatEvidence | undefined): OutputFormats | null {
	if (!evidence) return null;
	const values = evidence.values.filter(saved);
	const fallback = values[0];
	const preselected =
		evidence.default !== undefined && values.includes(evidence.default as GalleryFormat)
			? evidence.default
			: fallback;
	return { values, preselected };
}

const rows = new Map((projection.rows as FormatRow[]).map((row) => [row.model, row]));

/** The offered formats of a derived Poyo.ai image row, or null when it has no format option. */
export function poyoOutputFormats(model: string): OutputFormats | null {
	const row = rows.get(model);
	if (!row) throw new Error(`${model} is not a derived Poyo.ai image row.`);
	return offeredFormats(row.output_format);
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
