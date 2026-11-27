// The Queue projections of the derived Poyo.ai rows. `bun run catalog:derive` writes
// src/lib/shared/media-catalog/poyo-queue.json, the rows the browser's composer and Review read,
// and src/lib/server/providers/poyo/queue-schemas.json, the schemas the server re-validates each
// request against. A row joins only when every static Queue condition holds; any other row is
// pending with the first condition it fails.
import { canonicalJson } from "../../src/lib/shared/media-catalog/canonical";
import {
	optionClass,
	qualifiedClasses,
	unqualifiedClass,
} from "../../src/lib/shared/media-catalog/eligibility";
import { offeredFormats } from "../../src/lib/shared/media-catalog/formats";
import type {
	QueueField,
	QueueKey,
	QueueProjection,
	QueueRow,
} from "../../src/lib/shared/media-catalog/queue-row";
import { releasedOperations } from "../../src/lib/shared/media-catalog/registry";
import { reviewedRules } from "../../src/lib/shared/media-catalog/rules";
import { type Schema, validateBody } from "../../src/lib/shared/media-catalog/schema";
import { type DerivedOption, type DerivedRow, deriveRows, offeredDomain } from "./derive";
import { sha256 } from "./project";
import catalog from "./sources/poyo-ec73207.json";
import openapi from "./sources/poyo-openapi-2026-11-26.json";
import record from "./sources/sources.json";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** Siluet's prompt envelope where neither schema nor page states a limit (spec). */
export const imagePromptEnvelope = 5000;
const operation = "text-to-image";
const route = "POST /api/generate/submit";
// Each released Poyo.ai model keeps its reviewed descriptor and shipped Queue path.
const verified = new Set<string>(
	releasedOperations.filter(({ key }) => key.provider === "poyo").map(({ key }) => key.model),
);
const queueing = new Set(["declared", "open-absent", "open-absent-fixed"]);

export type PendingQueueRow = { model: string; operation: string; reason: string };

const isSchema = (value: unknown): value is Schema =>
	!!value && typeof value === "object" && !Array.isArray(value);
const entries = new Map(catalog.entries.map((entry) => [entry.model_id, entry]));
const apiSchemas = openapi.schemas as Record<string, Schema>;

/** The schemas behind a row, by the SHA-256 the row records. */
function rowSchemas(row: DerivedRow) {
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
	// Options with a gap have no covered path and are not sent; a fixed count is no option.
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

/** Every Queue-eligible text-to-image row, and why each other candidate is pending. */
export function queueProjection(rows: DerivedRow[] = deriveRows()) {
	const eligible: QueueRow[] = [];
	const pending: PendingQueueRow[] = [];
	for (const row of rows) {
		if (
			row.media !== "image" ||
			!row.operations.includes(operation) ||
			!queueing.has(row.d4.d4) ||
			verified.has(row.model)
		)
			continue;
		const made = queueRow(row);
		if (typeof made === "string") pending.push({ model: row.model, operation, reason: made });
		else eligible.push(made);
	}
	return { revision: record.catalog.revision, rows: eligible, pending };
}

/** Canonical compact JSON of the browser's queue rows, with one final newline. */
export function renderQueue(rows?: DerivedRow[]) {
	const { revision, rows: eligible } = queueProjection(rows);
	const projection: QueueProjection = { revision, rows: eligible };
	return `${canonicalJson(projection)}\n`;
}

/** Canonical compact JSON of the server's schemas for each queue row, with one final newline. */
export function renderQueueSchemas(rows?: DerivedRow[]) {
	const derived = rows ?? deriveRows();
	const { rows: eligible } = queueProjection(derived);
	const bound: Record<string, { catalog: string; rest: string | null }> = {};
	const schemas: Record<string, Schema> = {};
	for (const entry of eligible) {
		const row = derived.find((candidate) => candidate.model === entry.key.model) as DerivedRow;
		const pinned = rowSchemas(row);
		bound[`${entry.key.model} ${entry.key.operation}`] = entry.schemas;
		schemas[pinned.catalog.sha256] = pinned.catalog.schema;
		if (pinned.rest) schemas[pinned.rest.sha256] = pinned.rest.schema;
	}
	return `${canonicalJson({ rows: bound, schemas })}\n`;
}

export const queuePath = new URL(
	"../../src/lib/shared/media-catalog/poyo-queue.json",
	import.meta.url,
);
export const queueSchemasPath = new URL(
	"../../src/lib/server/providers/poyo/queue-schemas.json",
	import.meta.url,
);
