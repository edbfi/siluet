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
