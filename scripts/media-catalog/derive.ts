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
import { offeredFormats } from "../../src/lib/shared/media-catalog/formats";
import { releasedOperations } from "../../src/lib/shared/media-catalog/registry";
import {
	galleryEnvelope,
	type OutputNote,
	outputNotes,
	type QualifierDisposition,
	qualifierDispositions,
	type ReviewedFieldExclusion,
	type ReviewedOverride,
	reviewedFieldExclusions,
	reviewedOverrides,
	reviewedRules,
} from "../../src/lib/shared/media-catalog/rules";
import {
	boundRules,
	type Construct,
	effectiveDefault,
	type ReviewedRule,
	type Schema,
	uncovered,
	validateBody,
} from "../../src/lib/shared/media-catalog/schema";
import { sha256 } from "./project";
import pageReviews from "./sources/page-reviews.json";
import catalog from "./sources/poyo-ec73207.json";
import openapi from "./sources/poyo-openapi-2026-11-26.json";
import record from "./sources/sources.json";
import { verifiedOptions } from "./verified";

const d4Field = "enable_safety_checker";
const freeText = new Set(["prompt", "negative_prompt", "text", "author", "domain_name"]);
/**
 * The output-count convention: `n` whose description begins with one of these (spec, "family
 * conventions"). Any other count needs a reviewed note that quotes the provider.
 */
const countConvention = ["Number of output images", "Number of images to generate"];
export const countNotes: Record<string, string> = {
	"ideogram-vector-1.0/text-to-vector n": "Output count, from 1 to 8. Defaults to 1.",
	"kling-4.0-image n":
		"Number of images. When enable_sequential is false: 1–9, default 1. When enable_sequential is true: 2–10, default 4.",
};
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
	// Its page is not pinned, so no reviewed source documents the domain (G4 plan, A2).
	"gpt-image-2 size": "question 11",
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
	/** The state of values beyond a reviewed rule's listed set, such as custom sizes. */
	custom?: { state: "pending" | "unknown"; reason: string; question?: number };
};
/** A pair of values a schema refuses together: `when` one field has a value, `refuses` others. */
export type Combination = {
	when: Record<string, Json>;
	refuses: Record<string, Json[]>;
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
	/**
	 * How a text-to-image row sends one output: `1` where a documented count field accepts 1,
	 * `null` where a reviewed note shows its mode returns one output. Absent when not evaluated.
	 */
	count?: 1 | null;
	inputs: string[];
	options: DerivedOption[];
	/** The schemas' `not {A, B}` combinations, which the composer disables and Queue refuses. */
	combinations?: Combination[];
};

const isSchema = (value: unknown): value is Schema =>
	!!value && typeof value === "object" && !Array.isArray(value);
const propertiesOf = (schema: Schema | null) =>
	(schema && isSchema(schema.properties) ? schema.properties : {}) as Record<string, Schema>;

/** A top-level input's own declaration, never one found on a prototype. */
const ownDeclaration = (schema: Schema | null, field: string) => {
	const properties = propertiesOf(schema);
	return Object.hasOwn(properties, field) ? properties[field] : undefined;
};

/** A reviewed quote must be the provider's words in the description it is bound to. */
function quoted(quote: string, declaration: Schema | undefined, name: string) {
	const description = declaration?.description;
	if (!quote || typeof description !== "string" || !description.includes(quote))
		throw new Error(`${name} quotes text its field's description lacks.`);
}

function side(schema: Schema | null): RestSide {
	if (!schema) return "none";
	if (Object.hasOwn(propertiesOf(schema), d4Field)) return "declared";
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

// A media or subject input, never a creator option: a URI, an array of URIs, or a media or
// subject name. An array of other values, such as Recraft's `colors` palette of RGB objects, is
// an option.
export const isMedia = (field: string, declaration: Schema) =>
	declaration.format === "uri" ||
	(isSchema(declaration.items) && declaration.items.format === "uri") ||
	/_urls?$/.test(field) ||
	/^(elements|keyframes|kling_elements|multi_prompt)$/.test(field);

/** An output count only under the description convention or a reviewed note. */
function isCount(model: string, field: string, declaration: Schema) {
	const description = typeof declaration.description === "string" ? declaration.description : "";
	if (Object.hasOwn(countNotes, `${model} ${field}`)) {
		if (description !== countNotes[`${model} ${field}`])
			throw new Error(`The ${model} ${field} count note no longer matches its description.`);
		return true;
	}
	return field === "n" && countConvention.some((opening) => description.startsWith(opening));
}

function kindOf(model: string, field: string, declaration: Schema): DerivedOption["kind"] {
	if (isCount(model, field, declaration)) return "count";
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
		const declaration = Object.hasOwn(properties, field) ? properties[field] : {};
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
	// Not in the pinned catalog: the REST input alone, until a re-pin lists the entry.
	if (restSide === "declared") return { d4: "declared" };
	if (restSide === "closed") return { d4: "closed-absent", closedBy: "api" };
	if (restSide === "open") return { d4: "open-absent" };
	return { d4: "unknown" };
}

/** The evidence one row derives from: the OpenAPI projection and the reviewed rules. */
export type RowSources = {
	readonly models: Readonly<Record<string, { input: string; spec: string; shared?: true }>>;
	readonly schemas: Readonly<Record<string, Schema>>;
	readonly rules: readonly ReviewedRule[];
	readonly overrides?: readonly ReviewedOverride[];
	/** Each in-scope spec's `info.description`, by spec path. */
	readonly descriptions?: Readonly<Record<string, string>>;
	/** Each listed spec's SHA-256, by path. */
	readonly manifest?: Readonly<Record<string, string>>;
	/** Reviewed model pages: their SHA-256 and recorded one-output quotes, by URL. */
	readonly pages?: Readonly<
		Record<string, { sha256: string; outputs: Readonly<Record<string, string>> }>
	>;
	readonly outputNotes?: readonly OutputNote[];
	readonly fieldExclusions?: readonly ReviewedFieldExclusion[];
};
const pinned: RowSources = {
	models: openapi.models as RowSources["models"],
	schemas: openapi.schemas as RowSources["schemas"],
	rules: reviewedRules,
	overrides: reviewedOverrides,
	descriptions: openapi.descriptions,
	manifest: Object.fromEntries(openapi.manifest.map(({ path, sha256 }) => [path, sha256])),
	pages: Object.fromEntries(
		pageReviews.pages.map((page) => [
			page.url,
			{ sha256: page.sha256, outputs: ("outputs" in page && page.outputs) || {} },
		]),
	),
	outputNotes,
	fieldExclusions: reviewedFieldExclusions,
};

// Verified representatives keep their reviewed descriptors (spec, "Families and admission").
const verifiedModels = new Set<string>(
	releasedOperations.filter(({ key }) => key.provider === "poyo").map(({ key }) => key.model),
);
// Rows whose sources state no output count, held by an open question (spec, question 6).
const outputQuestions: Record<string, number> = { "qwen-image-3": 6, "qwen-image-3-pro": 6 };
const queueing = new Set(["declared", "open-absent", "open-absent-fixed"]);

/**
 * A schema's top-level `allOf` branches of the form `not {A: one value, B: values}` with both
 * required: the composer disables the pair, and the validator refuses it.
 */
function combinationsOf(schema: Schema | null): Combination[] {
	const branches = schema && Array.isArray(schema.allOf) ? schema.allOf : [];
	return branches.flatMap((branch): Combination[] => {
		const not = isSchema(branch) && Object.keys(branch).length === 1 ? branch.not : undefined;
		if (!isSchema(not) || !isSchema(not.properties) || !Array.isArray(not.required)) return [];
		const fields = Object.entries(not.properties as Record<string, Schema>);
		if (
			fields.length !== 2 ||
			Object.keys(not).some((key) => key !== "properties" && key !== "required") ||
			not.required.length !== 2 ||
			!fields.every(
				([field, constraint]) =>
					(not.required as unknown[]).includes(field) &&
					Object.keys(constraint).length === 1 &&
					Array.isArray(constraint.enum),
			)
		)
			return [];
		const [[a, first], [b, second]] = fields;
		const single = (first.enum as Json[]).length === 1;
		const [when, whenValue, refused, values] = single
			? [a, (first.enum as Json[])[0], b, second.enum as Json[]]
			: [b, (second.enum as Json[])[0], a, first.enum as Json[]];
		if (!single && (second.enum as Json[]).length !== 1) return [];
		return [{ when: { [when]: whenValue }, refuses: { [refused]: values } }];
	});
}

/** The documented domain of one option on one operation, after the reviewed value overrides. */
export function narrowedDomain(
	row: Pick<DerivedRow, "model" | "catalog">,
	option: DerivedOption,
	operation: string,
	overrides: readonly ReviewedOverride[] = reviewedOverrides,
): Domain {
	const excludes = overrides
		.filter(
			(override) =>
				override.model === row.model &&
				override.operation === operation &&
				override.field === option.field &&
				override.schemaSha256 === row.catalog,
		)
		.flatMap(({ excludes }) => excludes);
	if (!excludes.length || !option.domain.values) return option.domain;
	return {
		...option.domain,
		values: option.domain.values.filter((value) => !excludes.includes(value)),
	};
}

/** Values of one option that a Siluet envelope withholds until a later slice raises it. */
export function envelopeValues(
	row: Pick<DerivedRow, "media">,
	option: DerivedOption,
	domain: Domain,
) {
	if (
		row.media !== "image" ||
		!(galleryEnvelope.fields as readonly string[]).includes(option.field)
	)
		return [];
	return (domain.values ?? []).filter((value) =>
		(galleryEnvelope.values as readonly Json[]).includes(value),
	);
}

/** What the composer may offer on one operation: the narrowed domain, less envelope values. */
export function offeredDomain(
	row: Pick<DerivedRow, "model" | "catalog" | "media">,
	option: DerivedOption,
	operation: string,
): Domain {
	const domain = narrowedDomain(row, option, operation);
	const withheld = envelopeValues(row, option, domain);
	if (!withheld.length) return domain;
	return { ...domain, values: domain.values?.filter((value) => !withheld.includes(value)) };
}

/**
 * Whether a reviewed note shows this mode returns one output: its quote stands in the bound
 * source at the bound digest. A quote missing from a source at its digest fails derivation; a
 * changed digest makes the note stale.
 */
function noted(
	model: string,
	operation: string,
	{ outputNotes: notes = [], descriptions = {}, manifest = {}, pages = {} }: RowSources,
) {
	return notes.some((note) => {
		if (note.model !== model || note.operation !== operation) return false;
		const { source } = note;
		const [digest, text] =
			source.kind === "openapi-info"
				? [manifest[source.spec], descriptions[source.spec]]
				: [pages[source.url]?.sha256, pages[source.url]?.outputs[model]];
		if (digest !== source.sha256) return false;
		if (typeof text !== "string" || !text.includes(note.quote) || !note.quote)
			throw new Error(`The ${model} ${operation} output note quotes text its source lacks.`);
		return true;
	});
}

/** A ledger row's fields a derived row keeps. */
export type LedgerRow = { media: string; route: string | null; operations: string[] };
/** A catalog entry's projected fields. */
export type CatalogEntry = Pick<
	Entry,
	"model_id" | "category" | "status" | "service_type" | "execution_mode"
> & { input_schema: Schema; billing: unknown };

/** One documented Poyo.ai ID's row, from its catalog entry and OpenAPI input. */
export function deriveRow(
	row: LedgerRow,
	model: string,
	entry: CatalogEntry | undefined,
	sources: RowSources = pinned,
): DerivedRow {
	const { models, schemas, rules: allRules, overrides = [], fieldExclusions = [] } = sources;
	const api = Object.hasOwn(models, model) ? models[model] : undefined;
	const apiSchema = api && Object.hasOwn(schemas, api.input) ? schemas[api.input] : null;
	const catalogSchema = entry ? entry.input_schema : null;
	const schemaSources = [catalogSchema, apiSchema].filter((schema): schema is Schema => !!schema);
	const catalogSha = catalogSchema && sha256(canonicalJson(catalogSchema));
	const bindings = [
		...(catalogSchema
			? [{ schema: catalogSchema, sha256: catalogSha, source: "catalog" as const }]
			: []),
		...(apiSchema && api
			? [{ schema: apiSchema, sha256: api.input, source: "rest" as const }]
			: []),
	].map((binding) => ({ ...binding, rules: allRules }));
	for (const { schema, sha256: digest, source } of bindings)
		for (const rule of allRules)
			if (rule.source === source && rule.schemaSha256 === digest)
				quoted(
					rule.quote,
					rule.field === null ? schema : ownDeclaration(schema, rule.field),
					rule.id,
				);
	for (const override of overrides)
		if (override.model === model && catalogSchema && override.schemaSha256 === catalogSha)
			quoted(
				override.quote,
				ownDeclaration(catalogSchema, override.field),
				`The ${model} ${override.field} override`,
			);
	// A field exclusion removes the option from every operation of the row, or derivation fails.
	const excluded = new Set<string>();
	for (const exclusion of fieldExclusions) {
		if (exclusion.model !== model || !catalogSchema || exclusion.schemaSha256 !== catalogSha)
			continue;
		quoted(
			exclusion.quote,
			ownDeclaration(catalogSchema, exclusion.field),
			`The ${model} ${exclusion.field} exclusion`,
		);
		const covered = fieldExclusions.filter(
			(other) =>
				other.model === model &&
				other.field === exclusion.field &&
				other.schemaSha256 === catalogSha,
		);
		if (
			!row.operations.every((operation) => covered.some((other) => other.operation === operation))
		)
			throw new Error(`The ${model} ${exclusion.field} exclusion does not cover every operation.`);
		excluded.add(exclusion.field);
	}
	const rules = bindings.flatMap(({ schema, ...binding }) => boundRules(schema, binding));
	const unsupported = bindings.flatMap(({ schema, ...binding }) => uncovered(schema, binding));
	const required = [
		...new Set(
			schemaSources.flatMap((schema) => (Array.isArray(schema.required) ? schema.required : [])),
		),
	] as string[];
	const pending: string[] = [];
	if (!entry) pending.push("not in the pinned catalog");
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
		if (field === d4Field || excluded.has(field)) continue;
		const inCatalog = ownDeclaration(catalogSchema, field);
		const inApi = ownDeclaration(apiSchema, field);
		const declaration = (inCatalog ?? inApi) as Schema;
		if (isMedia(field, declaration)) {
			inputs.push(field);
			continue;
		}
		// A shared multi-model spec lists other models' fields too. The closed catalog entry is
		// this model's own contract, so such a field is simply not one of its options.
		if (!inCatalog && api?.shared && catalogSchema?.additionalProperties === false) continue;
		const found = unsupported.filter((construct) => construct.field === field);
		const ruled = rules.some((rule) => rule.field === field);
		const kind = found.length ? "construct" : ruled ? "rule" : kindOf(model, field, declaration);
		const a = domainOf(declaration);
		const b = inCatalog && inApi ? domainOf(inApi) : undefined;
		const { domain, disputed } = shared(a, b);
		// A reviewed rule whose domain is a listed set projects as an enum of those values.
		const fieldRules = kind === "rule" ? rules.filter((rule) => rule.field === field) : [];
		if (fieldRules.length && fieldRules.every((rule) => rule.values))
			domain.values = (fieldRules[0].values as string[]).filter((value) =>
				fieldRules.every((rule) => rule.values?.includes(value)),
			);
		const custom = fieldRules.find((rule) => rule.custom)?.custom;
		const resolved = effectiveDefault(schemaSources, field);
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
		if (custom) option.custom = { ...custom };
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
		else if (field === "output_format") {
			// Formats are offered only from a typed enum that Gallery can save (G3).
			const values = domain.values;
			const typed =
				kind === "enum" &&
				!!values?.every((value) => typeof value === "string") &&
				(resolved.state !== "resolved" || typeof resolved.value === "string");
			const reason = !typed
				? "output format is not a typed enum"
				: offeredFormats({ values: values as string[] }).state === "unsavable"
					? "Gallery saves none of its output formats"
					: null;
			if (reason) option.gap = { state: "pending", reason };
		} else if (kind === "prose") {
			const route = Object.hasOwn(proseDomains, `${model} ${field}`)
				? proseDomains[`${model} ${field}`]
				: undefined;
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
			rest: apiSchema && api ? { schema: apiSchema, sha256: api.input } : null,
		};
		const attempts = [required, ...inputs.map((input) => [...required, input])].map((fields) =>
			validateBody(schemas, minimalBody([...new Set(fields)], properties), rules),
		);
		if (attempts.every((errors) => errors.length))
			pending.push(`no valid minimal request: ${attempts[0][0]}`);
	}

	// One output per request (spec): text-to-image rows this slice can queue send `n: 1` where a
	// documented count field accepts 1, or need a note that the mode returns one output. Edits
	// and closed-schema rows are evaluated by the slices that own them (G5, G6).
	let count: 1 | null | undefined;
	if (
		row.media === "image" &&
		row.operations.includes("text-to-image") &&
		queueing.has(d4.d4) &&
		!verifiedModels.has(model)
	) {
		const field = options.find((option) => option.kind === "count");
		const accepts =
			field &&
			(field.domain.values
				? field.domain.values.includes(1)
				: (field.domain.minimum ?? 1) <= 1 && (field.domain.maximum ?? 1) >= 1);
		if (accepts) count = 1;
		else if (noted(model, "text-to-image", sources)) count = null;
		else
			pending.push(
				Object.hasOwn(outputQuestions, model)
					? `no evidence of one output: question ${outputQuestions[model]}`
					: "no evidence of one output",
			);
	}

	const combinations = [
		...new Map(
			[...combinationsOf(catalogSchema), ...combinationsOf(apiSchema)].map((rule) => [
				canonicalJson(rule),
				rule,
			]),
		).values(),
	];
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
		...(count !== undefined && { count }),
		inputs,
		options,
		...(combinations.length && { combinations }),
	};
}

const qualifier = /\bonly\b|also supports/i;

/** Each description at any depth of a schema, with its path. */
function descriptions(schema: unknown, path: string[] = []): [string, string][] {
	if (!schema || typeof schema !== "object") return [];
	const own: [string, string][] =
		!Array.isArray(schema) && typeof (schema as Schema).description === "string"
			? [[path.join("/"), (schema as Schema).description as string]]
			: [];
	return [
		...own,
		...Object.entries(schema).flatMap(([key, value]) =>
			key === "description" ? [] : descriptions(value, [...path, key]),
		),
	];
}

/**
 * Model-scoped qualifiers ("only", "also supports") in schemas that several models share, each
 * without a reviewed disposition, or whose narrowing disposition lacks a named model's exclusion.
 */
export function qualifierProblems({
	entries = catalog.entries as unknown as CatalogEntry[],
	openapi: projected = pinned,
	dispositions = qualifierDispositions,
	exclusions = reviewedFieldExclusions,
	overrides = reviewedOverrides,
}: {
	entries?: readonly CatalogEntry[];
	openapi?: Pick<RowSources, "models" | "schemas">;
	dispositions?: readonly QualifierDisposition[];
	exclusions?: readonly ReviewedFieldExclusion[];
	overrides?: readonly ReviewedOverride[];
} = {}) {
	const catalogSha = new Map(
		entries.map((entry) => [entry.model_id, sha256(canonicalJson(entry.input_schema))]),
	);
	const groups = new Map<string, { sources: Set<string>; models: Set<string>; schema: Schema }>();
	const add = (source: string, digest: string, model: string, schema: Schema) => {
		const group = groups.get(digest) ?? { sources: new Set(), models: new Set(), schema };
		group.sources.add(source);
		group.models.add(model);
		groups.set(digest, group);
	};
	for (const entry of entries)
		add("catalog", catalogSha.get(entry.model_id) as string, entry.model_id, entry.input_schema);
	for (const [model, { input }] of Object.entries(projected.models))
		if (Object.hasOwn(projected.schemas, input))
			add("rest", input, model, projected.schemas[input]);
	const problems: string[] = [];
	for (const [digest, { sources, models, schema }] of groups) {
		if (models.size < 2) continue;
		const label = `${[...sources].sort().join("+")} ${digest.slice(0, 12)}`;
		for (const [path, description] of descriptions(schema)) {
			if (!qualifier.test(description)) continue;
			const disposition = dispositions.find(
				(candidate) =>
					candidate.schemaSha256 === digest &&
					candidate.path === path &&
					!!candidate.quote &&
					description.includes(candidate.quote),
			);
			if (!disposition) {
				problems.push(
					`${label} ${path} (${[...models].sort().join(", ")}): ${JSON.stringify(description)}`,
				);
				continue;
			}
			if (disposition.applies.to !== "narrowed") continue;
			for (const model of disposition.applies.models) {
				const bound = [...exclusions, ...overrides].some(
					(exclusion) =>
						exclusion.model === model &&
						models.has(model) &&
						exclusion.schemaSha256 === catalogSha.get(model) &&
						description.includes(exclusion.quote),
				);
				if (!bound)
					problems.push(
						`${label} ${path}: ${model} has no exclusion quoting ${JSON.stringify(disposition.quote)}`,
					);
			}
		}
	}
	return problems.sort(byCodeUnit);
}

const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Every documented Poyo.ai ledger ID, as one derived row per exact ID. */
export function deriveRows(
	ledgerRows: typeof ledger.providers.poyo.rows = ledger.providers.poyo.rows,
) {
	const entries = new Map(
		catalog.entries.map((entry) => [entry.model_id, entry as unknown as CatalogEntry]),
	);
	const rows = ledgerRows
		.filter((row) => row.contract === "documented")
		.flatMap((row) => row.ids.map((model) => deriveRow(row, model, entries.get(model))));
	rows.sort((a, b) => (a.model < b.model ? -1 : a.model > b.model ? 1 : 0));
	const repeated = rows.find((row, index) => index > 0 && rows[index - 1].model === row.model);
	if (repeated) throw new Error(`${repeated.model} is documented in more than one ledger row.`);
	crossCheck(rows);
	const problems = qualifierProblems();
	if (problems.length)
		throw new Error(`Unreviewed qualifiers in shared schemas:\n${problems.join("\n")}`);
	return rows;
}

/** Each verified representative's reviewed choices must lie within its derived row. */
export function crossCheck(rows: DerivedRow[], verified = verifiedOptions(rows)) {
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
					? choice.values.filter((value) => !domain.values?.includes(value as Json))
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
	// The picker projection reads the coverage assignments, which import this module.
	const { pickerPath, renderPicker } = await import("./picker");
	const picker = renderPicker();
	writeFileSync(pickerPath, picker);
	console.log(`poyo-picker.json ${sha256(picker)} (${picker.length} bytes)`);
	const { formatsPath, renderFormats } = await import("./formats");
	const formats = renderFormats();
	writeFileSync(formatsPath, formats);
	console.log(`poyo-formats.json ${sha256(formats)} (${formats.length} bytes)`);
}
