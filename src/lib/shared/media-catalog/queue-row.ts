// The shape of one Queue-eligible derived row in poyo-queue.json. `bun run catalog:derive`
// writes the projection; nothing here reads it.
import type { FilteringEvidence } from "./filtering";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** An exact operation key: provider, model ID, route and operation. */
export type QueueKey = {
	readonly provider: "poyo";
	readonly model: string;
	readonly route: "POST /api/generate/submit";
	readonly operation: "text-to-image";
};

/** One creator option the composer offers and the request sends. */
export type QueueField = {
	readonly wire: string;
	readonly kind: "enum" | "boolean" | "integer";
	/** An enum's offered values, in schema order and sent verbatim. */
	readonly values?: readonly Json[];
	/** The value the composer starts on: the effective default, or the first offered value. */
	readonly preselect?: Json;
	readonly min?: number;
	readonly max?: number;
	/** Omitted from the request when empty (`seed`: "Omit to use a random seed"). */
	readonly optional?: true;
};

/** A pair the schemas refuse together: when one field has a value, these values of another. */
export type QueueCombination = {
	readonly when: Readonly<Record<string, Json>>;
	readonly refuses: Readonly<Record<string, readonly Json[]>>;
};

export type QueueRow = {
	readonly key: QueueKey;
	/** The prompt's limits in code points; Siluet's image envelope where none is documented. */
	readonly prompt: { readonly min: number; readonly max: number; readonly documented: boolean };
	/** `1`: Siluet sends `n: 1`. `null`: the mode returns one output without a count field. */
	readonly count: 1 | null;
	readonly fields: readonly QueueField[];
	readonly combinations: readonly QueueCombination[];
	readonly d4: FilteringEvidence;
	/** The output formats Gallery saves that the row offers, or null when it has no option. */
	readonly formats: readonly string[] | null;
	/** The pricing feed's key for this row. */
	readonly rateKey: string;
	/** The SHA-256 of the row's billing and input schema, as the price basis binds it. */
	readonly basis: string;
	/** The schemas the server re-validates the body against, by SHA-256. */
	readonly schemas: { readonly catalog: string; readonly rest: string | null };
	/** Review shows the Gallery size statement: no derived request bounds its output. */
	readonly gallery: true;
	/** SHA-256 of the canonical row without this field, bound into Review and the claim. */
	readonly contract: string;
};

export type QueueProjection = {
	/** The pinned catalog revision the rows derive from. */
	readonly revision: string;
	/** When Poyo.ai published that revision, as the sources record states it. */
	readonly publishedAt: string;
	readonly rows: readonly QueueRow[];
};
