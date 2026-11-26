// An in-repo validator for the JSON Schema subset that Poyo.ai's catalog and OpenAPI inputs use
// (docs/SPEC-catalog-engine.md, "Deriving and validating rows"). Anything outside the subset is
// reported as a construct: an option it touches has no covered path, and a construct on a
// required input or the whole schema keeps the row pending. Only a reviewed rule bound to the
// schema's SHA-256 replaces a construct.

export type Schema = { readonly [keyword: string]: unknown };
export type Body = { readonly [field: string]: unknown };

/** The only patterns the validator runs. Every other pattern is a construct. */
export const allowedPatterns: Readonly<Record<string, RegExp>> = {
	"\\S": /\S/u,
	"^https?://": /^https?:\/\//u,
	"^https?://\\S+$": /^https?:\/\/\S+$/u,
	"^\\d+x\\d+$": /^\d+x\d+$/u,
};

const annotations = ["description", "title", "example", "examples", "default"];
const valueKeywords = [
	"type",
	"enum",
	"minimum",
	"maximum",
	"minLength",
	"maxLength",
	"minItems",
	"maxItems",
	"items",
	"format",
	"pattern",
];
const combinators = ["allOf", "not", "if", "then", "else", "anyOf"];
const declarationTypes = ["string", "integer", "number", "boolean", "array"];

/** One construct outside the subset. `field` is the top-level input it touches, or null. */
export type Construct = { field: string | null; construct: string };

const isSchema = (value: unknown): value is Schema =>
	!!value && typeof value === "object" && !Array.isArray(value);

function keywordConstruct(keyword: string, value: unknown) {
	if (keyword.startsWith("x-")) return keyword;
	if (keyword === "pattern")
		return typeof value === "string" && Object.hasOwn(allowedPatterns, value)
			? null
			: `pattern ${JSON.stringify(value)}`;
	if (keyword === "format") return value === "uri" ? null : `format ${JSON.stringify(value)}`;
	return null;
}

/** Constructs in a property declaration of the input object. */
function declarationConstructs(field: string, schema: unknown, item = false): Construct[] {
	if (!isSchema(schema)) return [{ field, construct: "non-schema property" }];
	if (!("type" in schema)) {
		const unsupported = Object.keys(schema).filter(
			(keyword) => !annotations.includes(keyword) && !valueKeywords.includes(keyword),
		);
		return unsupported.length
			? unsupported.map((construct) => ({ field, construct }))
			: [{ field, construct: "untyped property" }];
	}
	if (schema.type === "object") return [{ field, construct: "nested object" }];
	if (typeof schema.type !== "string" || !declarationTypes.includes(schema.type))
		return [{ field, construct: `type ${JSON.stringify(schema.type)}` }];
	if (item && schema.type === "array") return [{ field, construct: "nested array" }];
	const found: Construct[] = [];
	for (const [keyword, value] of Object.entries(schema)) {
		if (annotations.includes(keyword)) continue;
		if (!valueKeywords.includes(keyword)) {
			found.push({ field, construct: keyword });
			continue;
		}
		const construct = keywordConstruct(keyword, value);
		if (construct) found.push({ field, construct });
	}
	if (schema.type === "array") {
		if (!("items" in schema)) found.push({ field, construct: "array without items" });
		else found.push(...declarationConstructs(field, schema.items, true));
	} else if ("items" in schema) found.push({ field, construct: "items on a non-array" });
	return found;
}

/** Constructs in a constraint fragment inside `allOf`, `not`, `if`, `then`, `else` or `anyOf`. */
function fragmentConstructs(schema: unknown, inAnyOf = false): Construct[] {
	if (!isSchema(schema)) return [{ field: null, construct: "non-schema fragment" }];
	const found: Construct[] = [];
	for (const [keyword, value] of Object.entries(schema)) {
		if (annotations.includes(keyword) || keyword === "required") continue;
		if (keyword === "properties" && isSchema(value)) {
			for (const [field, constraint] of Object.entries(value)) {
				if (!isSchema(constraint)) found.push({ field, construct: "non-schema constraint" });
				else
					for (const [inner, innerValue] of Object.entries(constraint)) {
						if (annotations.includes(inner)) continue;
						const construct = valueKeywords.includes(inner)
							? keywordConstruct(inner, innerValue)
							: inner;
						if (construct || inner === "items")
							found.push({ field, construct: construct ?? inner });
					}
			}
			continue;
		}
		if (inAnyOf) {
			found.push({ field: null, construct: `anyOf branch with ${keyword}` });
			continue;
		}
		found.push(...combinatorConstructs(keyword, value));
	}
	if (inAnyOf && !Array.isArray(schema.required))
		found.push({ field: null, construct: "anyOf branch without required" });
	return found;
}

function combinatorConstructs(keyword: string, value: unknown): Construct[] {
	if (keyword === "allOf")
		return Array.isArray(value)
			? value.flatMap((branch) => fragmentConstructs(branch))
			: [{ field: null, construct: "allOf" }];
	if (keyword === "anyOf")
		return Array.isArray(value)
			? value.flatMap((branch) => fragmentConstructs(branch, true))
			: [{ field: null, construct: "anyOf" }];
	if (keyword === "not" || keyword === "if" || keyword === "then" || keyword === "else")
		return fragmentConstructs(value);
	return [{ field: null, construct: keywordConstruct(keyword, value) ?? keyword }];
}

/** Every construct in an `input` schema that the validator does not support. */
export function constructs(schema: Schema): Construct[] {
	const found: Construct[] = [];
	if (schema.type !== "object") found.push({ field: null, construct: "input is not an object" });
	for (const [keyword, value] of Object.entries(schema)) {
		if (annotations.includes(keyword) || keyword === "type" || keyword === "required") continue;
		if (keyword === "properties" && isSchema(value)) {
			for (const [field, declaration] of Object.entries(value))
				found.push(...declarationConstructs(field, declaration));
			continue;
		}
		if (keyword === "additionalProperties") {
			if (typeof value !== "boolean")
				found.push({ field: null, construct: "additionalProperties schema" });
			continue;
		}
		if (combinators.includes(keyword)) found.push(...combinatorConstructs(keyword, value));
		else found.push({ field: null, construct: keywordConstruct(keyword, value) ?? keyword });
	}
	return found;
}

/** A reviewed cross-field rule that replaces one construct on one exact schema. */
export type ReviewedRule = {
	readonly id: string;
	readonly model: string;
	readonly source: "catalog" | "rest";
	/** SHA-256 of the canonical schema the rule was checked against. */
	readonly schemaSha256: string;
	/** The top-level input whose construct the rule replaces. */
	readonly field: string;
	readonly quote: string;
	readonly check: (value: unknown, body: Body) => string | null;
};

const codePoints = (value: string) => [...value].length;
const sameValue = (a: unknown, b: unknown) =>
	a === b ||
	(typeof a === "object" && typeof b === "object" && JSON.stringify(a) === JSON.stringify(b));

function typeError(type: unknown, value: unknown) {
	const ok =
		type === "string"
			? typeof value === "string"
			: type === "integer"
				? Number.isInteger(value)
				: type === "number"
					? typeof value === "number" && Number.isFinite(value)
					: type === "boolean"
						? typeof value === "boolean"
						: type === "array"
							? Array.isArray(value)
							: type === "object"
								? isSchema(value)
								: false;
	return ok ? null : `must be ${String(type)}`;
}

const isUri = (value: string) =>
	/^[A-Za-z][A-Za-z0-9+.-]*:\S+$/u.test(value) && URL.canParse(value);

/** Errors of one value against one supported schema or fragment. */
function check(schema: Schema, value: unknown, at: string, errors: string[]) {
	const fail = (message: string) => errors.push(`${at || "input"} ${message}`);
	if ("type" in schema) {
		const error = typeError(schema.type, value);
		if (error) return fail(error);
	}
	if (Array.isArray(schema.enum) && !schema.enum.some((option) => sameValue(option, value)))
		fail("is not an allowed value");
	if (typeof value === "number") {
		if (typeof schema.minimum === "number" && value < schema.minimum)
			fail(`is below ${schema.minimum}`);
		if (typeof schema.maximum === "number" && value > schema.maximum)
			fail(`is above ${schema.maximum}`);
	}
	if (typeof value === "string") {
		if (typeof schema.minLength === "number" && codePoints(value) < schema.minLength)
			fail(`is shorter than ${schema.minLength} characters`);
		if (typeof schema.maxLength === "number" && codePoints(value) > schema.maxLength)
			fail(`is longer than ${schema.maxLength} characters`);
		if (schema.format === "uri" && !isUri(value)) fail("is not a URI");
		if (typeof schema.pattern === "string") {
			const pattern = allowedPatterns[schema.pattern];
			if (!pattern) fail("has a pattern outside the validator");
			else if (!pattern.test(value)) fail("does not match its pattern");
		}
	}
	if (Array.isArray(value)) {
		if (typeof schema.minItems === "number" && value.length < schema.minItems)
			fail(`has fewer than ${schema.minItems} items`);
		if (typeof schema.maxItems === "number" && value.length > schema.maxItems)
			fail(`has more than ${schema.maxItems} items`);
		if (isSchema(schema.items))
			for (const [index, item] of value.entries())
				check(schema.items, item, `${at}[${index}]`, errors);
	}
	if (isSchema(value)) {
		if (Array.isArray(schema.required))
			for (const field of schema.required)
				if (!Object.hasOwn(value, field as string)) fail(`needs ${field}`);
		const properties = isSchema(schema.properties) ? schema.properties : {};
		for (const [field, item] of Object.entries(value)) {
			const declared = properties[field];
			if (isSchema(declared)) check(declared, item, at ? `${at}.${field}` : field, errors);
			else if (schema.additionalProperties === false) fail(`does not accept ${field}`);
		}
	}
	for (const branch of Array.isArray(schema.allOf) ? schema.allOf : [])
		if (isSchema(branch)) check(branch, value, at, errors);
	if (isSchema(schema.not) && passes(schema.not, value)) fail("matches a forbidden combination");
	if (isSchema(schema.if)) {
		const branch = passes(schema.if, value) ? schema.then : schema.else;
		if (isSchema(branch)) check(branch, value, at, errors);
	}
	if (
		Array.isArray(schema.anyOf) &&
		!schema.anyOf.some((branch) => isSchema(branch) && passes(branch, value))
	)
		fail("matches none of its alternatives");
}

const passes = (schema: Schema, value: unknown) => {
	const errors: string[] = [];
	check(schema, value, "", errors);
	return errors.length === 0;
};

/**
 * Errors of a serialized `input` body against one schema. A construct on the whole schema
 * refuses every body. A field whose declaration holds a construct is refused when sent, unless
 * a reviewed rule bound to this schema's SHA-256 replaces it; the rule then checks that field.
 * No default is added before validating.
 */
export function validateInput(
	schema: Schema,
	body: Body,
	{ sha256, rules = [] }: { sha256?: string; rules?: readonly ReviewedRule[] } = {},
): string[] {
	const bound = rules.filter((rule) => rule.schemaSha256 === sha256);
	const unsupported = constructs(schema).filter(
		({ field }) => !bound.some((rule) => rule.field === field),
	);
	if (unsupported.some(({ field }) => field === null))
		return unsupported
			.filter(({ field }) => field === null)
			.map(({ construct }) => `input uses ${construct}`);
	const errors: string[] = [];
	for (const { field, construct } of unsupported)
		if (field !== null && Object.hasOwn(body, field))
			errors.push(`${field} is not offered: ${construct}`);
	const replaced = new Set(bound.map((rule) => rule.field));
	const properties = isSchema(schema.properties) ? schema.properties : {};
	const checked: Schema = {
		...schema,
		properties: Object.fromEntries(
			Object.entries(properties).map(([field, declaration]) => [
				field,
				replaced.has(field) || unsupported.some((c) => c.field === field) ? {} : declaration,
			]),
		),
	};
	check(checked, body, "", errors);
	for (const rule of bound)
		if (Object.hasOwn(body, rule.field)) {
			const error = rule.check(body[rule.field], body);
			if (error) errors.push(`${rule.field} ${error}`);
		}
	return errors;
}

/** The schemas a Poyo.ai body must satisfy: the catalog's, and the model's OpenAPI input. */
export type RowSchemas = {
	readonly catalog: { readonly schema: Schema; readonly sha256: string };
	readonly rest: { readonly schema: Schema; readonly sha256: string } | null;
};

/** A body is valid only against both schemas; a row without an OpenAPI spec uses the catalog. */
export function validateBody(
	schemas: RowSchemas,
	body: Body,
	rules: readonly ReviewedRule[] = [],
): string[] {
	const forSource = (source: "catalog" | "rest") => rules.filter((rule) => rule.source === source);
	return [
		...validateInput(schemas.catalog.schema, body, {
			sha256: schemas.catalog.sha256,
			rules: forSource("catalog"),
		}).map((error) => `catalog: ${error}`),
		...(schemas.rest
			? validateInput(schemas.rest.schema, body, {
					sha256: schemas.rest.sha256,
					rules: forSource("rest"),
				}).map((error) => `API: ${error}`)
			: []),
	];
}

export type EffectiveDefault =
	| { state: "resolved"; value: unknown }
	| { state: "unresolved"; reason: "missing" | "disputed" | "one source" };

/**
 * The default an omitted field takes: only when every applicable source lists the field and
 * all of them state the same default. Anything else is unresolved.
 */
export function effectiveDefault(sources: readonly Schema[], field: string): EffectiveDefault {
	const declarations = sources.map((schema) =>
		isSchema(schema.properties) ? schema.properties[field] : undefined,
	);
	if (declarations.some((declaration) => !isSchema(declaration)))
		return { state: "unresolved", reason: "one source" };
	const defaults = (declarations as Schema[]).map((declaration) =>
		"default" in declaration ? { value: declaration.default } : null,
	);
	if (defaults.some((entry) => entry === null)) return { state: "unresolved", reason: "missing" };
	const [first, ...rest] = defaults as { value: unknown }[];
	return rest.every((entry) => sameValue(entry.value, first.value))
		? { state: "resolved", value: first.value }
		: { state: "unresolved", reason: "disputed" };
}
