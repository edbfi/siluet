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

/**
 * One construct outside the subset. `field` is the top-level input it touches, or null for the
 * whole schema. `within` names the top-level combinator a construct sits in: anything
 * unsupported inside a combinator invalidates the whole schema.
 */
export type Construct = { field: string | null; construct: string; within?: string };

const isSchema = (value: unknown): value is Schema =>
	!!value && typeof value === "object" && !Array.isArray(value);
const has = (value: object, key: string) => Object.hasOwn(value, key);
const own = (value: Schema, key: string) => (has(value, key) ? value[key] : undefined);

const bounds = ["minimum", "maximum"];
const counts = ["minLength", "maxLength", "minItems", "maxItems"];

/** A supported keyword whose value has the wrong type, as a construct name, or null. */
function malformed(keyword: string, value: unknown) {
	const wrong =
		keyword === "enum"
			? !Array.isArray(value)
			: keyword === "required"
				? !Array.isArray(value) || value.some((name) => typeof name !== "string")
				: bounds.includes(keyword)
					? typeof value !== "number" || !Number.isFinite(value)
					: counts.includes(keyword)
						? !Number.isInteger(value) || (value as number) < 0
						: false;
	return wrong ? `malformed ${keyword}` : null;
}

function keywordConstruct(keyword: string, value: unknown) {
	if (keyword.startsWith("x-")) return keyword;
	if (keyword === "pattern")
		return typeof value === "string" && has(allowedPatterns, value)
			? null
			: `pattern ${JSON.stringify(value)}`;
	if (keyword === "format") return value === "uri" ? null : `format ${JSON.stringify(value)}`;
	return malformed(keyword, value);
}

/** `then` or `else` beside no `if`. */
const orphans = (schema: Schema) =>
	has(schema, "if") ? [] : ["then", "else"].filter((key) => has(schema, key));

/**
 * The construct that leaves a declaration nothing for the validator to run, or null: an untyped
 * declaration with no other construct, a nested object, an unknown type, an array of arrays.
 */
function opaqueConstruct(schema: Schema, item: boolean) {
	if (!has(schema, "type"))
		return Object.entries(schema).every(
			([keyword, value]) =>
				annotations.includes(keyword) || ownConstruct(schema, keyword, value) === null,
		)
			? "untyped property"
			: null;
	if (schema.type === "object") return "nested object";
	if (typeof schema.type !== "string" || !declarationTypes.includes(schema.type))
		return `type ${JSON.stringify(schema.type)}`;
	if (item && schema.type === "array") return "nested array";
	return null;
}

/** The construct one keyword of a declaration names, or null when the validator runs it. */
function ownConstruct(schema: Schema, keyword: string, value: unknown) {
	if (!valueKeywords.includes(keyword)) return keyword;
	if (keyword === "items") {
		if (!has(schema, "type")) return "items without type";
		return schema.type === "array" ? null : "items on a non-array";
	}
	return keywordConstruct(keyword, value);
}

/**
 * Constructs in a property declaration of the input object. A rule for an untyped field's
 * combinator never hides a malformed or disallowed keyword beside it.
 */
function declarationConstructs(field: string, schema: unknown, item = false): Construct[] {
	if (!isSchema(schema)) return [{ field, construct: "non-schema property" }];
	const whole = opaqueConstruct(schema, item);
	if (whole) return [{ field, construct: whole }];
	const found: Construct[] = [];
	for (const [keyword, value] of Object.entries(schema)) {
		if (annotations.includes(keyword)) continue;
		const construct = ownConstruct(schema, keyword, value);
		if (construct) found.push({ field, construct });
	}
	if (schema.type === "array") {
		if (!has(schema, "items")) found.push({ field, construct: "array without items" });
		else found.push(...declarationConstructs(field, schema.items, true));
	}
	return found;
}

/** Constructs in one field's constraint inside a fragment. */
function constraintConstructs(constraint: unknown): string[] {
	if (!isSchema(constraint)) return ["non-schema constraint"];
	const found: string[] = [];
	for (const [keyword, value] of Object.entries(constraint)) {
		if (annotations.includes(keyword)) continue;
		if (keyword === "items") found.push("items");
		else if (keyword === "type") {
			if (typeof value !== "string" || !declarationTypes.includes(value))
				found.push(`type ${JSON.stringify(value)}`);
		} else if (!valueKeywords.includes(keyword)) found.push(keyword);
		else {
			const construct = keywordConstruct(keyword, value);
			if (construct) found.push(construct);
		}
	}
	return found;
}

/** Constructs in a constraint fragment inside `allOf`, `not`, `if`, `then`, `else` or `anyOf`. */
function fragmentConstructs(schema: unknown, inAnyOf = false): string[] {
	if (!isSchema(schema)) return ["non-schema fragment"];
	const found: string[] = orphans(schema).map((key) => `${key} without if`);
	for (const [keyword, value] of Object.entries(schema)) {
		if (annotations.includes(keyword)) continue;
		if (keyword === "required") {
			const construct = malformed(keyword, value);
			if (construct) found.push(construct);
			continue;
		}
		if (keyword === "properties") {
			if (!isSchema(value)) found.push("non-schema properties");
			else
				for (const constraint of Object.values(value))
					found.push(...constraintConstructs(constraint));
			continue;
		}
		if (inAnyOf) {
			found.push(`anyOf branch with ${keyword}`);
			continue;
		}
		found.push(...combinatorConstructs(keyword, value));
	}
	if (inAnyOf && !Array.isArray(schema.required)) found.push("anyOf branch without required");
	return found;
}

function combinatorConstructs(keyword: string, value: unknown): string[] {
	if (keyword === "allOf")
		return Array.isArray(value) ? value.flatMap((branch) => fragmentConstructs(branch)) : ["allOf"];
	if (keyword === "anyOf")
		return Array.isArray(value)
			? value.flatMap((branch) => fragmentConstructs(branch, true))
			: ["anyOf"];
	if (keyword === "not" || keyword === "if" || keyword === "then" || keyword === "else")
		return fragmentConstructs(value);
	return [keywordConstruct(keyword, value) ?? keyword];
}

/** The top-level combinator a keyword belongs to: `then` and `else` belong to `if`. */
const combinatorOf = (keyword: string) =>
	keyword === "then" || keyword === "else" ? "if" : keyword;

/** Every construct in an `input` schema that the validator does not support. */
export function constructs(schema: Schema): Construct[] {
	const found: Construct[] = [];
	if (schema.type !== "object") found.push({ field: null, construct: "input is not an object" });
	for (const key of orphans(schema)) found.push({ field: null, construct: `${key} without if` });
	for (const [keyword, value] of Object.entries(schema)) {
		if (annotations.includes(keyword) || keyword === "type") continue;
		if (keyword === "required") {
			const construct = malformed(keyword, value);
			if (construct) found.push({ field: null, construct });
			continue;
		}
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
		if (combinators.includes(keyword)) {
			if ((keyword === "then" || keyword === "else") && !has(schema, "if")) continue;
			const within = combinatorOf(keyword);
			for (const construct of combinatorConstructs(keyword, value))
				found.push({ field: null, construct, within });
		} else found.push({ field: null, construct: keywordConstruct(keyword, value) ?? keyword });
	}
	return found;
}

/**
 * A reviewed rule that replaces named constructs on one exact schema: on one top-level input,
 * or, with `field: null`, a whole top-level combinator.
 */
export type ReviewedRule = {
	readonly id: string;
	readonly model: string;
	readonly source: "catalog" | "rest";
	/** SHA-256 of the canonical schema the rule was checked against. */
	readonly schemaSha256: string;
	/** The top-level input whose constructs the rule replaces, or null for the whole schema. */
	readonly field: string | null;
	/**
	 * The constructs it replaces: construct names on `field`, or top-level combinator keywords
	 * when `field` is null. Any other construct still counts. On a field, the rule removes only
	 * the keywords it names; every supported constraint beside them is still checked.
	 */
	readonly constructs: readonly string[];
	/** The provider's words, a substring of the bound field's description. */
	readonly quote: string;
	/** Checks the field's value, or the whole body for a schema-level rule. */
	readonly check: (value: unknown, body: Body) => string | null;
	/** The listed values the rule accepts, when its domain is a listed set (an enum class). */
	readonly values?: readonly string[];
	/** The state of the values beyond the listed set, such as custom sizes, until qualified. */
	readonly custom?: {
		readonly state: "pending" | "unknown";
		readonly reason: string;
		readonly question?: number;
	};
};

/** The combinators a schema-level rule may replace; `then` and `else` go with their `if`. */
const ruledCombinators = ["allOf", "not", "if", "anyOf"];

/** Whether a rule replaces one construct. */
const covers = (rule: ReviewedRule, { field, construct, within }: Construct) =>
	rule.field === null
		? field === null && within !== undefined && rule.constructs.includes(within)
		: rule.field === field && within === undefined && rule.constructs.includes(construct);

/** Which reviewed rules may apply to one schema: its source, its SHA-256 and its rules. */
export type Binding = {
	readonly sha256?: string | null;
	readonly source?: "catalog" | "rest";
	readonly rules?: readonly ReviewedRule[];
};

/**
 * The rules bound to this schema: reviewed for its source, at its SHA-256, and naming only
 * constructs present where they point. A schema-level rule names only top-level combinators.
 * Any other rule is refused and covers nothing.
 */
export function boundRules(schema: Schema, { sha256, source, rules = [] }: Binding) {
	const found = constructs(schema);
	return rules.filter(
		(rule) =>
			rule.source === source &&
			rule.schemaSha256 === sha256 &&
			rule.constructs.length > 0 &&
			rule.constructs.every(
				(name) =>
					(rule.field !== null || ruledCombinators.includes(name)) &&
					found.some((construct) => covers({ ...rule, constructs: [name] }, construct)),
			),
	);
}

/** The constructs no rule bound to this schema replaces. */
export function uncovered(schema: Schema, binding: Binding) {
	const bound = boundRules(schema, binding);
	return constructs(schema).filter((found) => !bound.some((rule) => covers(rule, found)));
}

/**
 * A declaration without the keywords behind the constructs its bound rules replace, on the
 * field and its items. A replaced opaque construct replaces the whole declaration.
 */
function stripped(declaration: unknown, replaced: readonly string[], item = false): Schema {
	if (!isSchema(declaration)) return {};
	const replaces = (construct: string | null) => construct !== null && replaced.includes(construct);
	if (replaces(opaqueConstruct(declaration, item))) return {};
	return Object.fromEntries(
		Object.entries(declaration).flatMap(([keyword, value]) =>
			annotations.includes(keyword)
				? [[keyword, value]]
				: replaces(ownConstruct(declaration, keyword, value))
					? []
					: [
							[
								keyword,
								keyword === "items" && declaration.type === "array"
									? stripped(value, replaced, true)
									: value,
							],
						],
		),
	);
}

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
	if (has(schema, "type")) {
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
			const pattern = has(allowedPatterns, schema.pattern)
				? allowedPatterns[schema.pattern]
				: undefined;
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
			for (const field of schema.required) if (!has(value, field as string)) fail(`needs ${field}`);
		const properties = isSchema(schema.properties) ? schema.properties : {};
		for (const [field, item] of Object.entries(value)) {
			const declared = own(properties, field);
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
 * a bound rule replaces every construct on it; the field is then checked without the keywords
 * the rule names, and by the rule. A schema-level rule replaces its combinators and checks the
 * whole body. No default is added before validating.
 */
export function validateInput(schema: Schema, body: Body, binding: Binding = {}): string[] {
	const bound = boundRules(schema, binding);
	const unsupported = uncovered(schema, binding);
	const whole = unsupported.filter(({ field }) => field === null);
	if (whole.length)
		return whole.map(
			({ construct, within }) => `input uses ${construct}${within ? ` in ${within}` : ""}`,
		);
	const errors: string[] = [];
	for (const { field, construct } of unsupported)
		if (field !== null && has(body, field)) errors.push(`${field} is not offered: ${construct}`);
	const replaced = (field: string | null) =>
		bound.filter((rule) => rule.field === field).flatMap((rule) => rule.constructs);
	const properties = isSchema(schema.properties) ? schema.properties : {};
	const checked: Schema = {
		...Object.fromEntries(
			Object.entries(schema).filter(([keyword]) => !replaced(null).includes(combinatorOf(keyword))),
		),
		properties: Object.fromEntries(
			Object.entries(properties).map(([field, declaration]) => [
				field,
				unsupported.some((c) => c.field === field) ? {} : stripped(declaration, replaced(field)),
			]),
		),
	};
	check(checked, body, "", errors);
	for (const rule of bound) {
		if (rule.field === null) {
			const error = rule.check(body, body);
			if (error) errors.push(`input ${error}`);
		} else if (has(body, rule.field)) {
			const error = rule.check(body[rule.field], body);
			if (error) errors.push(`${rule.field} ${error}`);
		}
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
	return [
		...validateInput(schemas.catalog.schema, body, {
			sha256: schemas.catalog.sha256,
			source: "catalog",
			rules,
		}).map((error) => `catalog: ${error}`),
		...(schemas.rest
			? validateInput(schemas.rest.schema, body, {
					sha256: schemas.rest.sha256,
					source: "rest",
					rules,
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
	if (!sources.length) return { state: "unresolved", reason: "missing" };
	const declarations = sources.map((schema) =>
		isSchema(schema.properties) ? own(schema.properties, field) : undefined,
	);
	if (declarations.some((declaration) => !isSchema(declaration)))
		return { state: "unresolved", reason: "one source" };
	const defaults = (declarations as Schema[]).map((declaration) =>
		has(declaration, "default") ? { value: declaration.default } : null,
	);
	if (defaults.some((entry) => entry === null)) return { state: "unresolved", reason: "missing" };
	const [first, ...rest] = defaults as { value: unknown }[];
	return rest.every((entry) => sameValue(entry.value, first.value))
		? { state: "resolved", value: first.value }
		: { state: "unresolved", reason: "disputed" };
}
