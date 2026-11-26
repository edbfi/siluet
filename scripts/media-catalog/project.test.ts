import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import ledger from "../../docs/media-catalog.v1.json";
import { canonicalJson } from "../../src/lib/shared/media-catalog/canonical";
import {
	indexedSpecs,
	modelInputs,
	openApiScope,
	projectCatalog,
	projectOpenApi,
	repin,
	resolveRefs,
	sha256,
} from "./project";
import record from "./sources/sources.json";

const hookLimit = 500 * 1024;
const read = (file: string) => readFileSync(new URL(`./sources/${file}`, import.meta.url), "utf8");
const catalogFile = read(record.catalog.file);
const openapiFile = read(record.openapi.file);

test("both projections are canonical compact JSON under the 500 KB hook with their recorded digests", () => {
	for (const [file, digest] of [
		[catalogFile, record.catalog.projectionSha256],
		[openapiFile, record.openapi.projectionSha256],
	]) {
		expect(`${canonicalJson(JSON.parse(file))}\n`).toBe(file);
		expect(Buffer.byteLength(file)).toBeLessThan(hookLimit);
		expect(sha256(file)).toBe(digest);
	}
	expect(record.catalog.upstreamSha256).toBe(ledger.providers.poyo.discovery.snapshot.sha256);
	expect(record.catalog.revision).toBe(ledger.providers.poyo.discovery.snapshot.revision);
	expect(read(record.catalog.license)).toContain("MIT License");
});

test("the catalog projection holds the 162 in-scope entries with only the projected fields", () => {
	const { entries, revision } = JSON.parse(catalogFile);
	expect(revision).toBe(record.catalog.revision);
	expect(entries).toHaveLength(162);
	for (const entry of entries)
		expect(Object.keys(entry).sort()).toEqual([
			"billing",
			"category",
			"execution_mode",
			"input_schema",
			"model_id",
			"service_type",
			"status",
		]);
	const listed = ledger.providers.poyo.rows.filter((row) => row.catalogCategory);
	expect(entries.map((entry: { model_id: string }) => entry.model_id).sort()).toEqual(
		listed.flatMap((row) => row.ids).sort(),
	);
});

test("the OpenAPI projection holds the full manifest and only in-scope inputs", () => {
	const projection = JSON.parse(openapiFile);
	expect(projection.manifest).toHaveLength(175);
	expect(projection.index.sha256).toBe(
		"5b84a6d3510eefc2f7f8cf600960db076772a4b841227cac85f1be5ff3330421",
	);
	// The SHA-256 of the `sha256  path` list in index order, as the inventory records it.
	expect(projection.manifestSha256).toBe(
		"3a830a65011f65cabc20993840381ba4ab54cc53f567302f3b87608523e048a0",
	);
	const scope = openApiScope(catalogFile);
	const models = Object.keys(projection.models);
	expect(models.every((id) => scope.has(id))).toBe(true);
	// 157 of the 162 catalog entries have a spec, and so do the two unpinned Ideogram v4.6 IDs.
	expect(models).toHaveLength(159);
	const used = new Set(Object.values(projection.models).map((m) => (m as { input: string }).input));
	expect(Object.keys(projection.schemas).sort()).toEqual([...used].sort());
	for (const [digest, schema] of Object.entries(projection.schemas))
		expect(sha256(canonicalJson(schema))).toBe(digest);
});

// Fresh fixtures for a re-pin: a two-entry catalog, an index and one spec per shape.
const fixtureCatalog = JSON.stringify({
	has_more: false,
	items: [
		{
			model_id: "fixture-video",
			category: "video",
			status: "stable",
			service_type: "generate",
			execution_mode: "async",
			input_schema: { type: "object", properties: { prompt: { type: "string" } } },
			billing: { type: "fixed" },
			title: "dropped",
		},
		{
			model_id: "fixture-chat",
			category: "chat",
			status: "stable",
			service_type: "generate",
			execution_mode: "sync",
			input_schema: {},
			billing: {},
		},
		{
			model_id: "fixture-image",
			category: "text2img",
			status: "stable",
			service_type: "generate",
			execution_mode: "async",
			input_schema: { type: "object", properties: { prompt: { type: "string" } } },
			billing: { type: "fixed" },
		},
	],
});
const fixtureIndex = `# Fixture\n\n## OpenAPI Specs\n\n- [one](/one.json)\n- [zh](/zh/one.json)\n\n## Other\n\n- [no](/no.json)\n`;
const spec = (models: string[], input: unknown, extra: object = {}) =>
	JSON.stringify({
		components: {
			schemas: {
				SubmitRequest: {
					type: "object",
					properties: { model: { type: "string", enum: models }, input },
				},
				Shared: { type: "object", properties: { prompt: { type: "string" } } },
				...extra,
			},
		},
	});

test("a re-pin fixture projects deterministically and keeps only in-scope entries", () => {
	const projected = projectCatalog(fixtureCatalog, "f00");
	expect(projected).toBe(
		`${canonicalJson({
			entries: ["fixture-image", "fixture-video"].map((model_id) => {
				const item = JSON.parse(fixtureCatalog).items.find(
					(entry: { model_id: string }) => entry.model_id === model_id,
				);
				const { title: _title, ...kept } = item;
				return kept;
			}),
			revision: "f00",
		})}\n`,
	);
	expect(projectCatalog(fixtureCatalog, "f00")).toBe(projected);
	expect(() => projectCatalog(JSON.stringify({ has_more: true, items: [] }), "f00")).toThrow();
	const files: Record<string, string> = {
		"/one.json": spec(["fixture-image", "other"], { $ref: "#/components/schemas/Shared" }),
		"/zh/one.json": "{}",
	};
	const openapi = JSON.parse(
		projectOpenApi(fixtureIndex, (path) => files[path], new Set(["fixture-image"]), "2026-01-01"),
	);
	expect(indexedSpecs(fixtureIndex)).toEqual(["/one.json", "/zh/one.json"]);
	expect(openapi.manifest.map(({ path }: { path: string }) => path)).toEqual([
		"/one.json",
		"/zh/one.json",
	]);
	expect(Object.keys(openapi.models)).toEqual(["fixture-image"]);
	expect(openapi.models["fixture-image"].shared).toBe(true);
	expect(Object.values(openapi.schemas)).toEqual([
		{ type: "object", properties: { prompt: { type: "string" } } },
	]);
});

test("a re-pin verifies the upstream digest before projecting", () => {
	const files: Record<string, string> = {
		"capability-catalog.json": fixtureCatalog,
		"llms.txt": fixtureIndex,
		"openapi/one.json": spec(["fixture-image"], { $ref: "#/components/schemas/Shared" }),
		"openapi/zh/one.json": "{}",
	};
	const expected = {
		...record,
		catalog: { ...record.catalog, revision: "f00", upstreamSha256: sha256(fixtureCatalog) },
	};
	const first = repin((path) => files[path], expected);
	expect(repin((path) => files[path], expected)).toEqual(first);
	expect(first.catalog).toBe(projectCatalog(fixtureCatalog, "f00"));
	expect(JSON.parse(first.openapi).models["fixture-image"].shared).toBeUndefined();
	expect(() =>
		repin(
			(path) => (path === "capability-catalog.json" ? `${fixtureCatalog} ` : files[path]),
			expected,
		),
	).toThrow("recorded SHA-256");
});

test("a remote $ref, a cycle or a missing target fails the projection", () => {
	const document = { components: { schemas: { Loop: { $ref: "#/components/schemas/Loop" } } } };
	expect(() => resolveRefs({ $ref: "https://example.com/schema.json" }, document)).toThrow(
		"Remote",
	);
	expect(() => resolveRefs({ $ref: "other.json#/x" }, document)).toThrow("Remote");
	expect(() => resolveRefs({ $ref: "#/components/schemas/Loop" }, document)).toThrow("Cyclic");
	expect(() => resolveRefs({ $ref: "#/components/schemas/Missing" }, document)).toThrow("Missing");
	const remote = spec(["fixture-image"], { $ref: "https://example.com/input.json" });
	expect(() =>
		projectOpenApi(fixtureIndex, () => remote, new Set(["fixture-image"]), "2026-01-01"),
	).toThrow("Remote");
});

test("a discriminator or an allOf branch selects each model's own input", () => {
	const branch = (prompt: number) => ({
		type: "object",
		properties: { input: { type: "object", properties: { prompt: { maxLength: prompt } } } },
	});
	const discriminated = JSON.parse(
		spec(
			["a", "b"],
			{ type: "object" },
			{
				A: branch(1),
				B: branch(2),
				Models: {
					oneOf: [{ $ref: "#/components/schemas/A" }, { $ref: "#/components/schemas/B" }],
					discriminator: {
						propertyName: "model",
						mapping: { a: "#/components/schemas/A", b: "#/components/schemas/B" },
					},
				},
			},
		),
	);
	const inputs = modelInputs(discriminated);
	expect(inputs.get("a")).toEqual({ input: branch(1).properties.input, shared: false });
	expect(inputs.get("b")).toEqual({ input: branch(2).properties.input, shared: false });
	const conditional = JSON.parse(spec(["a", "b"], { $ref: "#/components/schemas/Shared" }));
	conditional.components.schemas.SubmitRequest.allOf = [
		{
			if: { properties: { model: { const: "a" } } },
			// biome-ignore lint/suspicious/noThenProperty: `then` is the JSON Schema keyword under test.
			then: { properties: { input: branch(3).properties.input } },
		},
	];
	const selected = modelInputs(conditional);
	expect(selected.get("a")).toEqual({ input: branch(3).properties.input, shared: false });
	expect(selected.get("b")?.shared).toBe(true);
});
