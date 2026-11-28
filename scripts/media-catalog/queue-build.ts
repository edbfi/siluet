// One derived text-to-image row's Queue row, or the first static Queue condition it fails. The
// queue projections and the verified options share it; it imports no deriver at runtime, so the
// deriver's own imports stay acyclic.
import { canonicalJson } from "../../src/lib/shared/media-catalog/canonical";
import {
	optionClass,
	qualifiedClasses,
	unqualifiedClass,
} from "../../src/lib/shared/media-catalog/eligibility";
import { offeredFormats } from "../../src/lib/shared/media-catalog/formats";
import type { QueueField, QueueKey, QueueRow } from "../../src/lib/shared/media-catalog/queue-row";
import { reviewedRules } from "../../src/lib/shared/media-catalog/rules";
import { type Schema, validateBody } from "../../src/lib/shared/media-catalog/schema";
import type { DerivedOption, DerivedRow } from "./derive";
import { offeredDomain } from "./domains";
import { sha256 } from "./project";
import catalog from "./sources/poyo-ec73207.json";
import openapi from "./sources/poyo-openapi-2026-11-26.json";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** Siluet's prompt envelope where neither schema nor page states a limit (spec). */
export const imagePromptEnvelope = 5000;
const operation = "text-to-image";
const route = "POST /api/generate/submit";
const isSchema = (value: unknown): value is Schema =>
	!!value && typeof value === "object" && !Array.isArray(value);
const entries = new Map(catalog.entries.map((entry) => [entry.model_id, entry]));
const apiSchemas = openapi.schemas as Record<string, Schema>;

/** The schemas behind a row, by the SHA-256 the row records. */
export function rowSchemas(row: DerivedRow) {
	const entry = entries.get(row.model);
	if (!entry || !row.catalog) throw new Error(`${row.model} has no pinned catalog schema.`);
	return {
		catalog: { schema: entry.input_schema as Schema, sha256: row.catalog },
		rest: row.rest ? { schema: apiSchemas[row.rest], sha256: row.rest } : null,
	};
}

/** The prompt's shortest documented length in either schema, at least one code point. */
function promptMinLength(schemas: ReturnType<typeof rowSchemas>) {
	const lengths = [schemas.catalog.schema, schemas.rest?.schema].map((schema) => {
		const properties = schema && isSchema(schema.properties) ? schema.properties : {};
		const prompt = Object.hasOwn(properties, "prompt") ? properties.prompt : undefined;
		return isSchema(prompt) && typeof prompt.minLength === "number" ? prompt.minLength : 1;
	});
	return Math.max(1, ...lengths);
}

/** One sent option as a composer field, or why it cannot be offered. */
function field(row: DerivedRow, option: DerivedOption): QueueField | string {
	const resolved = option.default.state === "resolved" ? option.default.value : undefined;
	if (option.kind === "boolean")
		return {
			wire: option.field,
			kind: "boolean",
			preselect: typeof resolved === "boolean" ? resolved : false,
		};
	if (option.kind === "integer") {
		const { minimum, maximum } = option.domain;
		return {
			wire: option.field,
			kind: "integer",
			...(minimum !== undefined && { min: minimum }),
			...(maximum !== undefined && { max: maximum }),
			// "Omit to use a random seed": an empty seed is never sent.
			...(option.field === "seed"
				? { optional: true as const }
				: { preselect: (resolved ?? minimum ?? null) as Json }),
		};
	}
	let values = (offeredDomain(row, option, operation).values ?? []) as Json[];
	let preselect = values.includes(resolved as Json) ? (resolved as Json) : values[0];
	if (option.field === "output_format") {
		const formats = offeredFormats({
			values: values as string[],
			...(typeof resolved === "string" && { default: resolved }),
		});
		if (formats.state !== "offered") return "Gallery saves none of its output formats";
		values = [...formats.values];
		preselect = formats.preselected;
	}
	if (!values.length) return `it offers no ${option.field} value Siluet can send`;
	return { wire: option.field, kind: "enum", values, preselect };
}

/** The Queue row for one derived text-to-image row, or the first static condition it fails. */
export function queueRow(row: DerivedRow): QueueRow | string {
	if (row.pending.length) return row.pending[0];
	if (row.count === undefined) return "no evidence of one output";
	const schemas = rowSchemas(row);
	const prompt = row.options.find((option) => option.field === "prompt");
	if (prompt?.kind !== "free-text") return "no prompt field";
	// An unreviewed prompt limit keeps the row Review-only, rather than queueing on the envelope.
	if (prompt.gap?.state === "pending") return prompt.gap.reason;
	// A format Siluet cannot offer refuses the row: dropping it would leave the type to Poyo.ai.
	const format = row.options.find((option) => option.field === "output_format")?.gap;
	if (format) return format.reason;
	// Other options with a gap have no covered path and are not sent; a fixed count is no option.
	const sent = row.options.filter(
		(option) => option.field !== "prompt" && option.kind !== "count" && !option.gap,
	);
	const unqualified = sent.map(optionClass).find((name) => !qualifiedClasses.includes(name));
	if (unqualified) return unqualifiedClass(unqualified);
	const fields: QueueField[] = [];
	for (const option of sent) {
		const made = field(row, option);
		if (typeof made === "string") return made;
		fields.push(made);
	}
	const max = prompt.domain.maxLength ?? imagePromptEnvelope;
	const min = promptMinLength(schemas);
	// The request Review starts from must validate against both schemas, with no defaults added.
	const body = {
		prompt: "A".repeat(min),
		...Object.fromEntries(
			fields.filter((item) => !item.optional).map((item) => [item.wire, item.preselect]),
		),
		...(row.count === 1 && { n: 1 }),
		enable_safety_checker: false,
	};
	const errors = validateBody(schemas, body, reviewedRules);
	if (errors.length) return `the preselected request does not validate: ${errors[0]}`;
	const offered = new Set(fields.map((item) => item.wire));
	const output = fields.find((item) => item.wire === "output_format");
	const key: QueueKey = { provider: "poyo", model: row.model, route, operation };
	const contract = {
		key,
		prompt: { min, max, documented: prompt.domain.maxLength !== undefined },
		count: row.count,
		fields,
		combinations: (row.combinations ?? []).filter((rule) =>
			[...Object.keys(rule.when), ...Object.keys(rule.refuses)].every((name) => offered.has(name)),
		),
		d4: row.d4,
		formats: output ? (output.values as string[]) : null,
		rateKey: row.model,
		basis: row.basis as string,
		schemas: { catalog: schemas.catalog.sha256, rest: schemas.rest?.sha256 ?? null },
		gallery: true as const,
	};
	return { ...contract, contract: sha256(canonicalJson(contract)) };
}
