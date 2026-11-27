// When a derived row can Queue (catalog engine spec, "When a row can Review and Queue"). The
// deriver checks the static conditions when it writes the queue projection; the server's derived
// Review and Queue (services/queue/submission.ts) and the browser's Review (ImageReview.svelte)
// check D4, the price consent and the key.
/**
 * The option classes the Poyo.ai image family has qualified on a verified representative (spec,
 * "Families and admission"): Seedream 5.5's prompt, enums and formats, and qwen-image-2.1's
 * boolean (`prompt_extend`) and integer (`seed`). A row that sends any other class stays pending.
 */
export const qualifiedClasses: readonly string[] = [
	"prompt",
	"enum",
	"output_format",
	"boolean",
	"integer",
];

/** A derived option's field, kind and documented domain. */
export type OptionShape = {
	readonly field: string;
	readonly kind: string;
	readonly domain: { readonly values?: readonly unknown[] };
};

/**
 * The class of one option the row sends. A reviewed rule whose domain is a listed set projects
 * as an enum; anything else keeps its own kind as its class.
 */
export function optionClass({ field, kind, domain }: OptionShape) {
	if (field === "prompt") return "prompt";
	if (field === "output_format") return "output_format";
	if (kind === "enum" || (kind === "rule" && domain.values)) return "enum";
	return kind === "free-text" ? "free text" : kind;
}

/** The pending reason a row takes when it sends an unqualified class. */
export const unqualifiedClass = (name: string) => `class not yet qualified: ${name}`;

/** Shown on every derived Poyo.ai Review (spec, condition 5). */
export const poyoAccessNote =
	"Poyo.ai does not publish per-key model access. Siluet has checked only that this key works.";
