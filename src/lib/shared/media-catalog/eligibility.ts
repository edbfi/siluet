// When a derived row can Queue (catalog engine spec, "When a row can Review and Queue"). Review
// names the first condition that fails, and Queue then sends nothing. The deriver checks the
// static conditions when it writes the queue projection; Review and the server check the price
// consent and the key at Queue.
import { type FilteringEvidence, queueEvidenceProblem } from "./filtering";

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

/** Every Queue condition for one derived Review, in the spec's order. */
export type QueueConditions = {
	/** Why the family does not admit the row or its body does not validate, or null. */
	readonly contract: string | null;
	/** The class of each option the row sends. */
	readonly classes: readonly string[];
	readonly d4: FilteringEvidence;
	/** A known rate, the creator's unknown-price acceptance, or neither. */
	readonly price: "known" | "consented" | "unknown";
	/** Why Gallery cannot save the output, or null. */
	readonly save: string | null;
	/** Whether a balance-verified Poyo.ai key is saved. */
	readonly access: boolean;
};

/** Shown on every derived Poyo.ai Review (spec, condition 5). */
export const poyoAccessNote =
	"Poyo.ai does not publish per-key model access. Siluet has checked only that this key works.";

/** The D4 states a derived image row can queue on in this release, with their bound wording. */
function d4Blocker(evidence: FilteringEvidence) {
	if (evidence.d4 === "closed-absent")
		return "Queue is unavailable until closed-schema Poyo.ai images take their acknowledgement (G6).";
	if (evidence.d4 === "contradiction" || evidence.d4 === "refused" || evidence.d4 === "unknown")
		return queueEvidenceProblem(evidence, "poyo");
	return null;
}

/** The first failing Queue condition's message, or null when the row can queue. */
export function queueBlocker(conditions: QueueConditions): string | null {
	if (conditions.contract) return `Queue is unavailable: ${conditions.contract}.`;
	const unqualified = conditions.classes.find((name) => !qualifiedClasses.includes(name));
	if (unqualified) return `Queue is unavailable: ${unqualifiedClass(unqualified)}.`;
	const d4 = d4Blocker(conditions.d4);
	if (d4) return d4;
	if (conditions.price === "unknown") return "Accept the unknown price to queue this request.";
	if (conditions.save) return `Queue is unavailable: ${conditions.save}.`;
	if (!conditions.access) return "Connect a Poyo.ai key whose balance check passed in Settings.";
	return null;
}
