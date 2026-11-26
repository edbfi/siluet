// bun run catalog:derive: turns both Poyo.ai projections, the ledger and the reviewed rules
// into src/lib/shared/media-catalog/poyo-rows.json. Derived rows are data: nothing here makes a
// row Queue-eligible. Verified representatives keep their reviewed descriptors; the deriver
// only cross-checks them and fails on any disagreement.
import { writeFileSync } from "node:fs";
import ledger from "../../docs/media-catalog.v1.json";
import { canonicalJson } from "../../src/lib/shared/media-catalog/canonical";
import {
	type CatalogSide,
	d4Cell,
	type FilteringEvidence,
	type RestSide,
} from "../../src/lib/shared/media-catalog/filtering";
import { reviewedRules } from "../../src/lib/shared/media-catalog/rules";
import {
	type Construct,
	effectiveDefault,
	type Schema,
	uncovered,
	validateBody,
} from "../../src/lib/shared/media-catalog/schema";
import { sha256 } from "./project";
import pageReviews from "./sources/page-reviews.json";
import catalog from "./sources/poyo-747e5d7.json";
import openapi from "./sources/poyo-openapi-2026-11-26.json";
import record from "./sources/sources.json";
import { verifiedOptions } from "./verified";

const d4Field = "enable_safety_checker";
const freeText = new Set(["prompt", "negative_prompt", "text", "author", "domain_name"]);
const counts = new Set(["n", "max_images"]);
// Question 10 is assigned only after the model's page was read and found silent.
const silentPages = new Set(
	pageReviews.pages.flatMap((page) =>
		Object.entries(page.silent).flatMap(([model, fields]) =>
			(fields as string[]).map((field) => `${model} ${field}`),
		),
	),
);

/**
 * String options whose domain is only prose (inventory "Prose-only domains"). Each is offered
 * only through a reviewed typing rule; until then it has no covered path. Unlisted ones are
 * unknown with question 11.
 */
const proseDomains: Record<string, string> = {
	"minimax-h3-image size": "typing rule with G6",
	"gpt-image-2 size": "typing rule with G4",
	"gpt-image-2-edit size": "typing rule with G5",
	"poyo-ai/image-translator source_language": "question 6",
	"poyo-ai/image-translator target_language": "question 6",
	"wan2.7-edit-video audio_setting": "Phase 3 source-video work",
	"poyo-ai/video-translator source_language": "Phase 3 source-video work",
	"poyo-ai/video-translator target_language": "Phase 3 source-video work",
	"heygen-avatar-6 voice": "Phase 3 audio and avatars",
	"heygen-avatar-6 avatar": "Phase 3 audio and avatars",
	"heygen-avatar-6-turbo voice": "Phase 3 audio and avatars",
	"heygen-avatar-6-turbo avatar": "Phase 3 audio and avatars",
	"create-music-video task_id": "Phase 3 prerequisites",
	"create-music-video audio_id": "Phase 3 prerequisites",
	"generate-music-cover task_id": "Phase 3 prerequisites",
};

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Entry = (typeof catalog.entries)[number];
export type Domain = {
	values?: Json[];
	minimum?: number;
	maximum?: number;
	maxLength?: number;
};
export type DerivedOption = {
	field: string;
	kind:
		| "enum"
		| "integer"
		| "number"
		| "boolean"
		| "free-text"
		| "prose"
		| "count"
		| "construct"
		| "rule";
	/** The domain both sources accept; for free text, the documented length. */
	domain: Domain;
	/** Each source's domain where they disagree. */
	disputed?: { catalog: Domain; api: Domain };
	default: { state: "resolved"; value: Json } | { state: "unresolved"; reason: string };
	/** Why the option has no covered path beyond its row's slice, if any. */
	gap?: { state: "pending" | "unknown"; reason: string; question?: number };
};
export type DerivedRow = {
	model: string;
	media: string;
	route: string;
	operations: string[];
	category: string | null;
	catalog: string | null;
	/** SHA-256 of the model's OpenAPI (REST) input, or null without a spec. */
	rest: string | null;
	spec: string | null;
	basis: string | null;
	d4: FilteringEvidence;
	/** Reasons the whole row is pending, whatever its slice. */
	pending: string[];
	inputs: string[];
	options: DerivedOption[];
};

const isSchema = (value: unknown): value is Schema =>
	!!value && typeof value === "object" && !Array.isArray(value);
const propertiesOf = (schema: Schema | null) =>
	(schema && isSchema(schema.properties) ? schema.properties : {}) as Record<string, Schema>;

function side(schema: Schema | null): RestSide {
	if (!schema) return "none";
	if (d4Field in propertiesOf(schema)) return "declared";
	return schema.additionalProperties === false ? "closed" : "open";
}

function domainOf(declaration: Schema): Domain {
	const domain: Domain = {};
	if (Array.isArray(declaration.enum)) domain.values = declaration.enum as Json[];
	for (const key of ["minimum", "maximum", "maxLength"] as const)
		if (typeof declaration[key] === "number") domain[key] = declaration[key] as number;
	return domain;
}

/** The domain both sources accept, and whether they disagree. */
function shared(a: Domain, b: Domain | undefined) {
	if (!b) return { domain: a, disputed: false };
	const domain: Domain = {};
	if (a.values && b.values) {
		const both = b.values.map((value) => JSON.stringify(value));
		domain.values = a.values.filter((value) => both.includes(JSON.stringify(value)));
	} else if (a.values || b.values) domain.values = a.values ?? b.values;
	const tighter = (
		key: "minimum" | "maximum" | "maxLength",
		pick: (x: number, y: number) => number,
	) => {
		const [x, y] = [a[key], b[key]];
		if (x !== undefined && y !== undefined) domain[key] = pick(x, y);
		else if (x !== undefined || y !== undefined) domain[key] = x ?? y;
	};
	tighter("minimum", Math.max);
	tighter("maximum", Math.min);
	tighter("maxLength", Math.min);
	return { domain, disputed: canonicalJson(a) !== canonicalJson(b) };
}

const isMedia = (field: string, declaration: Schema) =>
	declaration.type === "array" ||
	declaration.format === "uri" ||
	/_urls?$/.test(field) ||
	/^(elements|keyframes|kling_elements|multi_prompt)$/.test(field);

function kindOf(field: string, declaration: Schema): DerivedOption["kind"] {
	if (counts.has(field)) return "count";
	if (freeText.has(field)) return "free-text";
	if (Array.isArray(declaration.enum)) return "enum";
	if (declaration.type === "integer") return "integer";
	if (declaration.type === "number") return "number";
	if (declaration.type === "boolean") return "boolean";
	if (declaration.type === "string" && !declaration.pattern && !declaration.format) return "prose";
	return "construct";
}

/** A body of only the required inputs, each with the smallest documented value. */
function minimalBody(required: string[], properties: Record<string, Schema>) {
	const body: Record<string, Json> = {};
	for (const field of required) {
		const declaration = properties[field] ?? {};
		const items = isSchema(declaration.items) ? declaration.items : {};
		if (Array.isArray(declaration.enum)) body[field] = declaration.enum[0] as Json;
		else if (declaration.type === "array")
			body[field] = Array.from(
				{ length: Math.max(1, Number(declaration.minItems ?? 1)) },
				(_, i) => (items.type === "string" ? `https://media.example/${i}.png` : {}),
			);
		else if (declaration.type === "integer" || declaration.type === "number")
			body[field] = Number(declaration.minimum ?? 1);
		else if (declaration.type === "boolean") body[field] = false;
		else if (declaration.format === "uri" || /_url$/.test(field))
			body[field] = "https://media.example/0.png";
		else body[field] = "A".repeat(Math.max(1, Number(declaration.minLength ?? 1)));
	}
	return body;
}

const constructNames = (found: Construct[]) => [
	...new Set(
		found.map(({ construct, within }) => (within ? `${construct} in ${within}` : construct)),
	),
];

function filtering(catalogSide: CatalogSide | null, restSide: RestSide): FilteringEvidence {
	if (catalogSide) return d4Cell(catalogSide, restSide);
	// Not in the pinned catalog: the REST input alone, until G2c pins the entry.
	if (restSide === "declared") return { d4: "declared" };
	if (restSide === "closed") return { d4: "closed-absent", closedBy: "api" };
	if (restSide === "open") return { d4: "open-absent" };
	return { d4: "unknown" };
}

function deriveRow(
	row: (typeof ledger.providers.poyo.rows)[number],
	model: string,
	entry: Entry | undefined,
): DerivedRow {
	const api = (openapi.models as Record<string, { input: string; spec: string; shared?: true }>)[
		model
	];
	const apiSchema = api ? ((openapi.schemas as Record<string, Schema>)[api.input] ?? null) : null;
	const catalogSchema = entry ? (entry.input_schema as Schema) : null;
	const sources = [catalogSchema, apiSchema].filter((schema): schema is Schema => !!schema);
	const catalogSha = catalogSchema && sha256(canonicalJson(catalogSchema));
	const rules = reviewedRules.filter(
		({ schemaSha256 }) => schemaSha256 === catalogSha || schemaSha256 === api?.input,
	);
	const unsupported = [
		...(catalogSchema ? uncovered(catalogSchema, catalogSha, rules) : []),
		...(apiSchema ? uncovered(apiSchema, api.input, rules) : []),
	];
	const required = [
		...new Set(
			sources.flatMap((schema) => (Array.isArray(schema.required) ? schema.required : [])),
		),
	] as string[];
	const pending: string[] = [];
	if (!entry) pending.push("not in the pinned catalog: G2c re-pins");
	if (entry && (entry.service_type !== "generate" || entry.execution_mode !== "async"))
		pending.push(`service ${entry.service_type}/${entry.execution_mode}`);
	const whole = unsupported.filter(({ field }) => field === null);
	if (whole.length) pending.push(`schema uses ${constructNames(whole).join(", ")}`);
	const onRequired = unsupported.filter(({ field }) => field !== null && required.includes(field));
	if (onRequired.length)
		pending.push(
			`required input uses ${[...new Set(onRequired.map(({ field, construct }) => `${field} ${construct}`))].join(", ")}`,
		);
	const d4 = filtering(
		catalogSchema ? (side(catalogSchema) as CatalogSide) : null,
		side(apiSchema),
	);
	if (d4.d4 === "contradiction" || d4.d4 === "refused" || d4.d4 === "unknown")
		pending.push(`D4 ${d4.d4}`);

	const catalogProps = propertiesOf(catalogSchema);
	const apiProps = propertiesOf(apiSchema);
	const fields = [...new Set([...Object.keys(catalogProps), ...Object.keys(apiProps)])].sort();
	const inputs: string[] = [];
	const options: DerivedOption[] = [];
	for (const field of fields) {
		if (field === d4Field) continue;
		const inCatalog = catalogProps[field];
		const inApi = apiProps[field];
		const declaration = inCatalog ?? inApi;
		if (isMedia(field, declaration)) {
			inputs.push(field);
			continue;
		}
		// A shared multi-model spec lists other models' fields too. The closed catalog entry is
		// this model's own contract, so such a field is simply not one of its options.
		if (!inCatalog && api?.shared && catalogSchema?.additionalProperties === false) continue;
		const found = unsupported.filter((construct) => construct.field === field);
		const ruled = rules.some((rule) => rule.field === field);
		const kind = found.length ? "construct" : ruled ? "rule" : kindOf(field, declaration);
		const a = domainOf(declaration);
		const b = inCatalog && inApi ? domainOf(inApi) : undefined;
		const { domain, disputed } = shared(a, b);
		const resolved = effectiveDefault(sources, field);
		const option: DerivedOption = {
			field,
			kind,
			domain,
			default:
				resolved.state === "resolved"
					? { state: "resolved", value: resolved.value as Json }
					: { state: "unresolved", reason: resolved.reason },
		};
		if (disputed && b) option.disputed = { catalog: a, api: b };
		const other = inCatalog ? apiSchema : catalogSchema;
		if (
			(!inCatalog || !inApi) &&
			apiSchema &&
			catalogSchema &&
			other?.additionalProperties === false
		)
			option.gap = {
				state: "unknown",
				reason: `only the ${inCatalog ? "catalog" : "API schema"} lists it, and the other is closed`,
				question: 7,
			};
		else if (found.length)
			option.gap = { state: "pending", reason: `uses ${constructNames(found).join(", ")}` };
		else if (kind === "free-text" && domain.maxLength === undefined)
			option.gap = silentPages.has(`${model} ${field}`)
				? { state: "unknown", reason: "prompt limit not documented", question: 10 }
				: { state: "pending", reason: "no documented limit: read the model page" };
		else if (kind === "prose") {
			const route = proseDomains[`${model} ${field}`];
			option.gap = route?.startsWith("question")
				? { state: "unknown", reason: "domain only in prose", question: Number(route.slice(9)) }
				: route
					? { state: "pending", reason: `domain only in prose: ${route}` }
					: { state: "unknown", reason: "domain not documented", question: 11 };
		}
		options.push(option);
	}

	// A row with no valid minimal request stays pending: its required inputs, alone or with one
	// media input, and no defaults added.
	if (!pending.length && catalogSchema && catalogSha) {
		const properties = { ...apiProps, ...catalogProps };
		const schemas = {
			catalog: { schema: catalogSchema, sha256: catalogSha },
			rest: apiSchema ? { schema: apiSchema, sha256: api.input } : null,
		};
		const attempts = [required, ...inputs.map((input) => [...required, input])].map((fields) =>
			validateBody(schemas, minimalBody([...new Set(fields)], properties), rules),
		);
		if (attempts.every((errors) => errors.length))
			pending.push(`no valid minimal request: ${attempts[0][0]}`);
	}

	return {
		model,
		media: row.media,
		route: row.route as string,
		operations: row.operations,
		category: entry?.category ?? null,
		catalog: catalogSha,
		rest: api?.input ?? null,
		spec: api?.spec ?? null,
		basis: entry
			? sha256(canonicalJson({ billing: entry.billing, input_schema: entry.input_schema }))
			: null,
		d4,
		pending,
		inputs,
		options,
	};
}

/** Every documented Poyo.ai ledger ID, as one derived row per exact ID. */
export function deriveRows() {
	const entries = new Map(catalog.entries.map((entry) => [entry.model_id, entry]));
	const rows = ledger.providers.poyo.rows
		.filter((row) => row.contract === "documented")
		.flatMap((row) => row.ids.map((model) => deriveRow(row, model, entries.get(model))));
	rows.sort((a, b) => (a.model < b.model ? -1 : 1));
	crossCheck(rows);
	return rows;
}

/** Each verified representative's reviewed choices must lie within its derived row. */
export function crossCheck(rows: DerivedRow[], verified = verifiedOptions) {
	for (const { key, offered } of verified) {
		if (key.provider !== "poyo") continue;
		const row = rows.find(({ model }) => model === key.model);
		if (!row) throw new Error(`${key.model} has no derived row.`);
		if (row.d4.d4 !== "declared" || !row.operations.includes(key.operation))
			throw new Error(`${key.model} disagrees with its derived row.`);
		for (const [field, choice] of Object.entries(offered)) {
			const option = row.options.find((candidate) => candidate.field === field);
			if (!option) throw new Error(`${key.model} offers undocumented ${field}.`);
			const { domain } = option;
			const outside =
				"values" in choice
					? choice.values.filter((value) => domain.values && !domain.values.includes(value as Json))
					: "maxCodePoints" in choice
						? domain.maxLength !== undefined && choice.maxCodePoints > domain.maxLength
							? [choice.maxCodePoints]
							: []
						: "maxBytes" in choice
							? []
							: [choice.minimum, choice.maximum].filter(
									(value) =>
										(domain.minimum !== undefined && value < domain.minimum) ||
										(domain.maximum !== undefined && value > domain.maximum),
								);
			if (outside.length)
				throw new Error(
					`${key.model} ${field} offers ${JSON.stringify(outside)} outside its documented domain.`,
				);
		}
	}
}

/** Canonical compact JSON, with the one final newline the repository's hooks expect. */
export function renderRows() {
	return `${canonicalJson({
		catalog: { revision: record.catalog.revision, sha256: record.catalog.projectionSha256 },
		openapi: { date: record.openapi.date, sha256: record.openapi.projectionSha256 },
		rows: deriveRows(),
	})}\n`;
}

export const rowsPath = new URL(
	"../../src/lib/shared/media-catalog/poyo-rows.json",
	import.meta.url,
);

if (import.meta.main) {
	const rows = renderRows();
	writeFileSync(rowsPath, rows);
	console.log(`poyo-rows.json ${sha256(rows)} (${rows.length} bytes)`);
}
