import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import catalog from "../../../../scripts/media-catalog/sources/poyo-747e5d7.json";
import openapi from "../../../../scripts/media-catalog/sources/poyo-openapi-2026-11-26.json";
import { canonicalJson } from "./canonical";
import { reviewedRules } from "./rules";
import {
	allowedPatterns,
	constructs,
	effectiveDefault,
	type ReviewedRule,
	type RowSchemas,
	type Schema,
	validateBody,
	validateInput,
} from "./schema";

const sha = (schema: unknown) => createHash("sha256").update(canonicalJson(schema)).digest("hex");
function row(id: string): RowSchemas {
	const entry = catalog.entries.find((item) => item.model_id === id);
	if (!entry) throw new Error(`No catalog entry for ${id}.`);
	const api = (openapi.models as Record<string, { input: string }>)[id];
	const apiSchema = api && (openapi.schemas as Record<string, Schema>)[api.input];
	return {
		catalog: { schema: entry.input_schema as Schema, sha256: sha(entry.input_schema) },
		rest: apiSchema ? { schema: apiSchema, sha256: api.input } : null,
	};
}
const isBody = (value: unknown): value is Record<string, unknown> =>
	!!value && typeof value === "object";
const object = (properties: Schema, extra: Schema = {}): Schema => ({
	type: "object",
	properties,
	...extra,
});

describe("supported constructs", () => {
	const cases: [string, Schema, unknown[], unknown[]][] = [
		["type string", object({ a: { type: "string" } }), ["x"], [1]],
		["type integer", object({ a: { type: "integer" } }), [3], [3.5, "3"]],
		["type number", object({ a: { type: "number" } }), [3.5], ["3.5"]],
		["type boolean", object({ a: { type: "boolean" } }), [false], [0]],
		["enum", object({ a: { type: "string", enum: ["x", "y"] } }), ["y"], ["z"]],
		[
			"minimum and maximum",
			object({ a: { type: "integer", minimum: 2, maximum: 4 } }),
			[2, 4],
			[1, 5],
		],
		// maxLength counts code points: one emoji is one.
		[
			"minLength and maxLength",
			object({ a: { type: "string", minLength: 2, maxLength: 3 } }),
			["ab", "😀😀😀"],
			["a", "abcd"],
		],
		[
			"array items, minItems and maxItems",
			object({
				a: { type: "array", minItems: 1, maxItems: 2, items: { type: "string", format: "uri" } },
			}),
			[["https://a.example/x"]],
			[
				[],
				["https://a.example/x", "https://b.example/y", "https://c.example/z"],
				["not a uri"],
				[1],
			],
		],
	];
	test.each(cases)("%s passes and refuses", (_name, schema, good, bad) => {
		expect(constructs(schema)).toEqual([]);
		for (const value of good) expect(validateInput(schema, { a: value })).toEqual([]);
		for (const value of bad) expect(validateInput(schema, { a: value })).not.toEqual([]);
	});

	test("required and additionalProperties", () => {
		const schema = object(
			{ a: { type: "string" } },
			{ required: ["a"], additionalProperties: false },
		);
		expect(validateInput(schema, { a: "x" })).toEqual([]);
		expect(validateInput(schema, {})).toEqual(["input needs a"]);
		expect(validateInput(schema, { a: "x", b: 1 })).toEqual(["input does not accept b"]);
		expect(validateInput({ ...schema, additionalProperties: true }, { a: "x", b: 1 })).toEqual([]);
	});

	test("default is never added before validating", () => {
		const schema = object(
			{ a: { type: "string", enum: ["x"], default: "x" } },
			{ required: ["a"] },
		);
		expect(validateInput(schema, {})).toEqual(["input needs a"]);
	});

	test("allOf, not, if/then/else and anyOf over required lists", () => {
		const schema = object(
			{ a: { type: "string" }, b: { type: "string" }, c: { type: "integer" } },
			{
				allOf: [
					{ not: { required: ["a", "b"] } },
					{
						if: { required: ["a"] },
						// biome-ignore lint/suspicious/noThenProperty: `then` is the JSON Schema keyword under test.
						then: { properties: { c: { maximum: 5 } } },
						else: { required: ["c"] },
					},
				],
				anyOf: [{ required: ["a"] }, { properties: { c: { minimum: 1 } }, required: ["c"] }],
			},
		);
		expect(constructs(schema)).toEqual([]);
		expect(validateInput(schema, { a: "x", c: 5 })).toEqual([]);
		expect(validateInput(schema, { c: 2 })).toEqual([]);
		expect(validateInput(schema, { a: "x", b: "y" })).not.toEqual([]);
		expect(validateInput(schema, { a: "x", c: 6 })).not.toEqual([]);
		expect(validateInput(schema, {})).not.toEqual([]);
		expect(validateInput(schema, { c: 0 })).not.toEqual([]);
	});
});

describe("patterns", () => {
	const values: Record<string, [string[], string[]]> = {
		"\\S": [
			["a", " a "],
			["", "   "],
		],
		"^https?://": [
			["https://x", "http://x y"],
			["ftp://x", " https://x"],
		],
		"^https?://\\S+$": [["https://x.example/a"], ["https://x y", "data:image/png;base64,AA"]],
		"^\\d+x\\d+$": [["1024x768"], ["1024 x 768", "1024X768", "4:3"]],
	};
	test("the allowlist is exactly the four reviewed patterns", () => {
		expect(Object.keys(allowedPatterns).sort()).toEqual(Object.keys(values).sort());
	});
	test.each(Object.entries(values))("%s runs on the value", (pattern, [good, bad]) => {
		const schema = object({ a: { type: "string", pattern } });
		expect(constructs(schema)).toEqual([]);
		for (const value of good) expect(validateInput(schema, { a: value })).toEqual([]);
		for (const value of bad) expect(validateInput(schema, { a: value })).not.toEqual([]);
	});
	test("any other pattern leaves its option uncovered, and the row is fine without it", () => {
		const schema = object(
			{
				prompt: { type: "string" },
				size: { type: "string", pattern: "^\\s*\\d+\\s*[xX]\\s*\\d+\\s*$" },
			},
			{ required: ["prompt"] },
		);
		expect(constructs(schema)).toEqual([
			{ field: "size", construct: 'pattern "^\\\\s*\\\\d+\\\\s*[xX]\\\\s*\\\\d+\\\\s*$"' },
		]);
		expect(validateInput(schema, { prompt: "x", size: "1024x768" })).toEqual([
			`size is not offered: pattern "^\\\\s*\\\\d+\\\\s*[xX]\\\\s*\\\\d+\\\\s*$"`,
		]);
		expect(validateInput(schema, { prompt: "x" })).toEqual([]);
	});
});

describe("constructs outside the subset", () => {
	test.each([
		["oneOf", { oneOf: [{ enum: ["a"] }, { pattern: "^\\d+x\\d+$" }] }, "oneOf"],
		["const", { type: "string", const: "a" }, "const"],
		[
			"x- keyword",
			{ type: "string", "x-video-duration-seconds": true },
			"x-video-duration-seconds",
		],
		["nested object", { type: "object", properties: {} }, "nested object"],
		["untyped", { description: "anything" }, "untyped property"],
		[
			"contains",
			{ type: "array", items: { type: "string" }, contains: { type: "string" } },
			"contains",
		],
	])("%s on an optional input uncovers only that option", (_name, declaration, construct) => {
		const schema = object(
			{ prompt: { type: "string" }, extra: declaration },
			{ required: ["prompt"] },
		);
		expect(constructs(schema)).toEqual([{ field: "extra", construct }]);
		expect(validateInput(schema, { prompt: "x" })).toEqual([]);
		expect(validateInput(schema, { prompt: "x", extra: "a" })).toEqual([
			`extra is not offered: ${construct}`,
		]);
	});
	test("a construct on the whole schema refuses every body", () => {
		const schema = object({ prompt: { type: "string" } }, { "x-server-validation": {} });
		expect(validateInput(schema, { prompt: "x" })).toEqual(["input uses x-server-validation"]);
		const oneOf = object({ prompt: { type: "string" } }, { oneOf: [{ required: ["prompt"] }] });
		expect(validateInput(oneOf, { prompt: "x" })).toEqual(["input uses oneOf"]);
	});
	test("an anyOf branch other than a required list is a construct", () => {
		const schema = object(
			{ a: { type: "string" } },
			{ anyOf: [{ properties: { a: { enum: ["x"] } } }] },
		);
		expect(constructs(schema).map(({ construct }) => construct)).toEqual([
			"anyOf branch without required",
		]);
	});
});

describe("combinators fail closed", () => {
	const fields = { a: { type: "string" }, b: { type: "string" } };
	test("a const inside a combinator fragment invalidates the whole schema", () => {
		const schema = object(fields, {
			// biome-ignore lint/suspicious/noThenProperty: `then` is the JSON Schema keyword under test.
			allOf: [{ if: { properties: { a: { const: "x" } } }, then: { required: ["b"] } }],
		});
		expect(constructs(schema)).toEqual([{ field: null, construct: "const", within: "allOf" }]);
		expect(validateInput(schema, { b: "y" })).toEqual(["input uses const in allOf"]);
	});
	test("a combinator-level const invalidates the whole schema", () => {
		const schema = object(fields, { allOf: [{ const: { a: "x" } }] });
		expect(constructs(schema)).toEqual([{ field: null, construct: "const", within: "allOf" }]);
		expect(validateInput(schema, { a: "x" })).toEqual(["input uses const in allOf"]);
	});
	test("a fragment type outside the declaration types invalidates the whole schema", () => {
		const schema = object(fields, { not: { properties: { a: { type: "object" } } } });
		expect(constructs(schema)).toEqual([
			{ field: null, construct: 'type "object"', within: "not" },
		]);
		expect(validateInput(schema, { a: "x" })).toEqual(['input uses type "object" in not']);
		const typed = object(fields, { not: { properties: { a: { type: "string", enum: ["x"] } } } });
		expect(constructs(typed)).toEqual([]);
	});
	test("only a schema-level rule for that exact combinator replaces it", () => {
		const schema = object(fields, {
			// biome-ignore lint/suspicious/noThenProperty: `then` is the JSON Schema keyword under test.
			allOf: [{ if: { properties: { a: { const: "x" } } }, then: { required: ["b"] } }],
		});
		const digest = sha(schema);
		const rule: ReviewedRule = {
			id: "fixture-allOf",
			model: "fixture",
			source: "catalog",
			schemaSha256: digest,
			field: null,
			constructs: ["allOf"],
			quote: "b is required when a is x",
			check: (body) => (isBody(body) && body.a === "x" && !("b" in body) ? "needs b" : null),
		};
		expect(validateInput(schema, { a: "x", b: "y" }, { sha256: digest, rules: [rule] })).toEqual(
			[],
		);
		expect(validateInput(schema, { a: "x" }, { sha256: digest, rules: [rule] })).toEqual([
			"input needs b",
		]);
		// A rule for another combinator, or a stale hash, leaves the schema refused.
		const anyOf = { ...rule, constructs: ["anyOf"] };
		expect(validateInput(schema, { a: "x", b: "y" }, { sha256: digest, rules: [anyOf] })).toEqual([
			"input uses const in allOf",
		]);
		expect(
			validateInput(schema, { a: "x", b: "y" }, { sha256: "0".repeat(64), rules: [rule] }),
		).toEqual(["input uses const in allOf"]);
	});
});

describe("malformed keywords are constructs", () => {
	test.each([
		["enum", { type: "string", enum: "x" }],
		["minimum", { type: "integer", minimum: "1" }],
		["maximum", { type: "integer", maximum: Number.POSITIVE_INFINITY }],
		["minLength", { type: "string", minLength: 1.5 }],
		["maxLength", { type: "string", maxLength: -1 }],
		["minItems", { type: "array", items: { type: "string" }, minItems: -1 }],
		["maxItems", { type: "array", items: { type: "string" }, maxItems: "2" }],
	])("a malformed %s uncovers its option", (keyword, declaration) => {
		const schema = object(
			{ prompt: { type: "string" }, extra: declaration },
			{ required: ["prompt"] },
		);
		expect(constructs(schema)).toEqual([{ field: "extra", construct: `malformed ${keyword}` }]);
		expect(validateInput(schema, { prompt: "x", extra: "a" })).toEqual([
			`extra is not offered: malformed ${keyword}`,
		]);
	});
	test.each([
		["required that is not an array", { required: "prompt" }, "malformed required"],
		["required that names a non-string", { required: [1] }, "malformed required"],
		// biome-ignore lint/suspicious/noThenProperty: `then` is the JSON Schema keyword under test.
		["then without if", { then: { required: ["prompt"] } }, "then without if"],
		["else without if", { else: { required: ["prompt"] } }, "else without if"],
	])("%s invalidates the whole schema", (_name, extra, construct) => {
		const schema = object({ prompt: { type: "string" } }, extra);
		expect(constructs(schema)).toEqual([{ field: null, construct }]);
		expect(validateInput(schema, { prompt: "x" })).toEqual([`input uses ${construct}`]);
	});
	test("a malformed keyword inside a fragment invalidates the whole schema", () => {
		const schema = object(
			{ a: { type: "string" } },
			{ allOf: [{ properties: { a: { enum: "x" } } }, { not: { required: "a" } }] },
		);
		expect(constructs(schema)).toEqual([
			{ field: null, construct: "malformed enum", within: "allOf" },
			{ field: null, construct: "malformed required", within: "allOf" },
		]);
	});
});

describe("only own properties resolve", () => {
	test("__proto__ in a body is an undeclared field", () => {
		const schema = object({ a: { type: "string" } }, { additionalProperties: false });
		expect(validateInput(schema, JSON.parse('{"__proto__": 1}'))).toEqual([
			"input does not accept __proto__",
		]);
	});
	test("an effective default needs a source that owns the field", () => {
		expect(effectiveDefault([], "a")).toEqual({ state: "unresolved", reason: "missing" });
		const source = JSON.parse('{"type":"object","properties":{}}') as Schema;
		expect(effectiveDefault([source], "__proto__")).toEqual({
			state: "unresolved",
			reason: "one source",
		});
	});
});

describe("rules cover exact constructs", () => {
	test("a rule for oneOf does not hide another construct on the same field", () => {
		const klein = row("flux-3-klein");
		const [catalogRule] = reviewedRules.filter(
			(item) => item.model === "flux-3-klein" && item.source === "catalog",
		);
		const properties = klein.catalog.schema.properties as Record<string, Schema>;
		const extra: Schema = {
			...klein.catalog.schema,
			properties: { ...properties, size: { ...properties.size, "x-server-validation": true } },
		};
		const digest = sha(extra);
		const rule = { ...catalogRule, schemaSha256: digest };
		expect(
			validateInput(extra, { prompt: "A fox", size: "3:2" }, { sha256: digest, rules: [rule] }),
		).toEqual(["size is not offered: x-server-validation"]);
		expect(validateInput(extra, { prompt: "A fox" }, { sha256: digest, rules: [rule] })).toEqual(
			[],
		);
	});
});

describe("reviewed rules", () => {
	const klein = row("flux-3-klein");
	const rule = reviewedRules.filter((item) => item.model === "flux-3-klein");
	test("the flux-3-klein rule is bound to the pinned schema and replaces its oneOf", () => {
		expect(rule.map(({ schemaSha256 }) => schemaSha256)).toEqual([
			klein.catalog.sha256,
			klein.rest?.sha256 as string,
		]);
		expect(constructs(klein.catalog.schema)).toEqual([{ field: "size", construct: "oneOf" }]);
		expect(constructs(klein.rest?.schema as Schema)).toEqual([
			{ field: "size", construct: "oneOf" },
		]);
	});
	test("a listed ratio passes, an unlisted ratio and the wrong tier are refused", () => {
		const body = (size: string, resolution?: string) => ({
			prompt: "A fox",
			size,
			...(resolution && { resolution }),
		});
		expect(validateBody(klein, body("3:2"), rule)).toEqual([]);
		expect(validateBody(klein, body("1536x1024", "2K"), rule)).toEqual([]);
		const both = (error: string) => [`catalog: size ${error}`, `API: size ${error}`];
		expect(validateBody(klein, body("21:9"), rule)).toEqual(
			both("is neither a listed ratio nor WIDTHxHEIGHT"),
		);
		expect(validateBody(klein, body("1536x1024", "1K"), rule)).toEqual(both("needs resolution 2K"));
		expect(validateBody(klein, body("1536x1024"), rule)).toEqual(both("needs resolution 2K"));
		expect(validateBody(klein, body("1530x1024", "2K"), rule)).toEqual(
			both("has a side not divisible by 16"),
		);
		expect(validateBody(klein, body("4112x1024", "4K"), rule)).toEqual(
			both("has a side outside 256-4096"),
		);
		expect(validateBody(klein, body("1536 x 1024", "2K"), rule)).not.toEqual([]);
	});
	test("explicit dimensions with a leading zero are refused", () => {
		expect(
			validateBody(klein, { prompt: "A fox", size: "01536x1024", resolution: "2K" }, rule),
		).toEqual([
			"catalog: size has a side with a leading zero",
			"API: size has a side with a leading zero",
		]);
	});
	test("a stale rule hash leaves the construct uncovered", () => {
		const stale = rule.map((item) => ({ ...item, schemaSha256: "0".repeat(64) }));
		expect(validateBody(klein, { prompt: "A fox", size: "3:2" }, stale)).toEqual([
			"catalog: size is not offered: oneOf",
			"API: size is not offered: oneOf",
		]);
		expect(validateBody(klein, { prompt: "A fox" }, stale)).toEqual([]);
	});
});

describe("both schemas", () => {
	test("gpt-image-2.6-fixed with resolution fails the closed API input and passes without it", () => {
		const fixed = row("gpt-image-2.6-fixed");
		expect(validateBody(fixed, { prompt: "A lamp", resolution: "1K" })).toEqual([
			"API: input does not accept resolution",
		]);
		expect(validateBody(fixed, { prompt: "A lamp" })).toEqual([]);
	});
	test.each(["protect_text", "synthesis_on_image", "translate_on_image"])(
		"poyo-ai/image-translator with %s fails the closed API input",
		(field) => {
			const translator = row("poyo-ai/image-translator");
			const body = { image_urls: ["https://img.example/sign.png"], target_language: "en" };
			expect(validateBody(translator, { ...body, [field]: 1 })).toEqual([
				`API: input does not accept ${field}`,
			]);
			expect(validateBody(translator, body)).toEqual([]);
		},
	);
	test("a disputed value fails and a shared one passes (seedream-4.5 n)", () => {
		const seedream = row("seedream-4.5");
		expect(validateBody(seedream, { prompt: "A quiet harbour", n: 1 })).toEqual([]);
		expect(validateBody(seedream, { prompt: "A quiet harbour", n: 6 })).toEqual([]);
		expect(validateBody(seedream, { prompt: "A quiet harbour", n: 7 })).toEqual([
			"API: n is above 6",
		]);
		expect(validateBody(seedream, { prompt: "A quiet harbour", n: 16 })).toEqual([
			"catalog: n is above 15",
			"API: n is above 6",
		]);
	});
	test("a row without an OpenAPI spec validates against the catalog alone", () => {
		const fixed = row("gpt-image-2.6-fixed");
		expect(validateBody({ ...fixed, rest: null }, { prompt: "A lamp", resolution: "1K" })).toEqual(
			[],
		);
	});
});

describe("effective defaults", () => {
	test("agree only when every source lists the field with the same default", () => {
		const fixed = row("gpt-image-2.6-fixed");
		const sources = [fixed.catalog.schema, fixed.rest?.schema as Schema];
		expect(effectiveDefault(sources, "resolution")).toEqual({
			state: "unresolved",
			reason: "one source",
		});
		expect(effectiveDefault(sources, "size")).toEqual({ state: "resolved", value: "1:1" });
		expect(effectiveDefault([fixed.catalog.schema], "resolution")).toEqual({
			state: "resolved",
			value: "1K",
		});
		expect(effectiveDefault(sources, "prompt")).toEqual({ state: "unresolved", reason: "missing" });
		const disputed = [
			object({ a: { type: "string", default: "x" } }),
			object({ a: { type: "string", default: "y" } }),
		];
		expect(effectiveDefault(disputed, "a")).toEqual({ state: "unresolved", reason: "disputed" });
	});
});
