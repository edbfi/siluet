// Projects Poyo.ai's public capability catalog and per-model OpenAPI specs into the compact,
// canonical sources the deriver reads. Inputs are untrusted downloads: nothing here executes
// them, and a remote `$ref` or an unexpected shape fails the projection.
//
// bun scripts/media-catalog/project.ts <mirror-dir>
//   <mirror-dir>/capability-catalog.json  the catalog at the recorded revision
//   <mirror-dir>/llms.txt                 the docs index
//   <mirror-dir>/openapi/<path>           each file the index lists under "OpenAPI Specs"
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalJson } from "../../src/lib/shared/media-catalog/canonical";
import record from "./sources/sources.json";

export const sha256 = (data: string | Uint8Array) =>
	createHash("sha256").update(data).digest("hex");

// Categories whose result is an image or a video, and the two music-task prerequisites whose
// operations produce one (generate-music-cover, create-music-video).
export const inScopeCategories = [
	"image",
	"image_tools",
	"img2img",
	"img2vid",
	"text2img",
	"text2vid",
	"translate",
	"video",
	"video2video",
] as const;
export const musicPrerequisites = ["create-music-video", "generate-music-cover"] as const;

type CatalogItem = Record<string, unknown> & { model_id: string; category: string };
type SourceRecord = typeof record;
const projectedFields = [
	"model_id",
	"category",
	"status",
	"service_type",
	"execution_mode",
	"input_schema",
	"billing",
] as const;

/** Whether a catalog entry belongs to the projection: by its category or as a music prerequisite. */
export function inScope(item: { model_id: string; category: string }) {
	return (
		(inScopeCategories as readonly string[]).includes(item.category) ||
		(musicPrerequisites as readonly string[]).includes(item.model_id)
	);
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	!!value && typeof value === "object" && !Array.isArray(value);
const stringFields = ["status", "service_type", "execution_mode"] as const;
const objectFields = ["input_schema", "billing"] as const;

/** An item with a string ID and category, or a failed projection. */
function catalogItem(item: unknown): CatalogItem {
	if (!isRecord(item) || typeof item.model_id !== "string" || typeof item.category !== "string")
		throw new Error(`The catalog has a malformed catalog entry: ${JSON.stringify(item)}.`);
	return item as CatalogItem;
}

/** An in-scope entry's projected fields, each of the shape the deriver reads. */
function projectedEntry(item: CatalogItem) {
	for (const field of projectedFields)
		if (!Object.hasOwn(item, field)) throw new Error(`${item.model_id} has no ${field}.`);
	for (const field of stringFields)
		if (typeof item[field] !== "string")
			throw new Error(`${item.model_id} has a malformed ${field}.`);
	for (const field of objectFields)
		if (!isRecord(item[field])) throw new Error(`${item.model_id} has a malformed ${field}.`);
	return Object.fromEntries(projectedFields.map((field) => [field, item[field]])) as {
		model_id: string;
	};
}

/** The in-scope entries of one catalog revision, sorted by model ID. */
export function projectCatalog(upstream: string, revision: string) {
	const catalog = JSON.parse(upstream) as { has_more?: unknown; items?: unknown };
	if (catalog.has_more !== false || !Array.isArray(catalog.items))
		throw new Error("The catalog is not one complete page of items.");
	const entries = catalog.items.map(catalogItem).filter(inScope).map(projectedEntry);
	entries.sort((a, b) => (a.model_id < b.model_id ? -1 : 1));
	const ids = entries.map((entry) => entry.model_id);
	if (new Set(ids).size !== ids.length) throw new Error("The catalog repeats a model ID.");
	return `${canonicalJson({ entries, revision })}\n`;
}

/**
 * The paths the docs index lists under "OpenAPI Specs", in index order. A bullet that is not a
 * local `.json` spec link fails, so no spec drops out of the manifest unseen.
 */
export function indexedSpecs(index: string) {
	const section = index.split(/^## OpenAPI Specs$/m)[1]?.split(/^## /m)[0];
	if (!section) throw new Error("The docs index has no OpenAPI Specs section.");
	return section
		.split("\n")
		.filter((line) => line.startsWith("- "))
		.map((line) => {
			const path = /^- \[[^\]]*\]\((\/[^)\s]+\.json)\)$/.exec(line)?.[1];
			if (!path) throw new Error(`The OpenAPI Specs section lists an unrecognised entry: ${line}`);
			return path;
		});
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };
const isObject = (value: Json | undefined): value is JsonObject =>
	!!value && typeof value === "object" && !Array.isArray(value);
const annotations = new Set(["description", "example", "examples", "title"]);

/** Resolves every local `$ref`, failing on a remote one, a cycle or a missing target. */
export function resolveRefs(value: Json, document: JsonObject, seen: string[] = []): Json {
	if (Array.isArray(value)) return value.map((item) => resolveRefs(item, document, seen));
	if (!isObject(value)) return value;
	if (Object.hasOwn(value, "$ref")) {
		const ref = value.$ref;
		if (typeof ref !== "string" || !ref.startsWith("#/"))
			throw new Error(`Remote or invalid $ref ${JSON.stringify(ref)}.`);
		if (seen.includes(ref)) throw new Error(`Cyclic $ref ${ref}.`);
		let target: Json | undefined = document;
		for (const part of ref.slice(2).split("/")) {
			const key = part.replaceAll("~1", "/").replaceAll("~0", "~");
			target = isObject(target) && Object.hasOwn(target, key) ? target[key] : undefined;
		}
		if (target === undefined) throw new Error(`Missing $ref target ${ref}.`);
		const siblings = Object.entries(value).filter(([key]) => key !== "$ref");
		if (siblings.some(([key]) => !annotations.has(key)))
			throw new Error(`$ref ${ref} has non-annotation siblings.`);
		const resolved = resolveRefs(target, document, [...seen, ref]);
		if (!siblings.length) return resolved;
		if (!isObject(resolved)) throw new Error(`$ref ${ref} with siblings is not an object.`);
		return { ...resolved, ...Object.fromEntries(siblings) };
	}
	return Object.fromEntries(
		Object.entries(value).map(([key, item]) => [key, resolveRefs(item, document, seen)]),
	);
}

const ownAt = (value: Json | undefined, key: string) =>
	isObject(value) && Object.hasOwn(value, key) ? value[key] : undefined;
const schemaAt = (document: JsonObject, name: string) => {
	const found = ownAt(ownAt(ownAt(document, "components"), "schemas"), name);
	return isObject(found) ? found : undefined;
};

/**
 * The model IDs a spec's `SubmitRequest.model.enum` lists, or null when it has no usable one.
 * An enum that repeats an ID fails.
 */
export function specModels(document: JsonObject) {
	const ids = ownAt(
		ownAt(ownAt(schemaAt(document, "SubmitRequest"), "properties"), "model"),
		"enum",
	);
	if (!Array.isArray(ids) || !ids.length || !ids.every((id) => typeof id === "string")) return null;
	const repeated = ids.find((id, index) => ids.indexOf(id) !== index);
	if (repeated !== undefined) throw new Error(`SubmitRequest.model.enum repeats ${repeated}.`);
	return ids as string[];
}

/**
 * The in-scope IDs a spec names anywhere outside an `example` or `examples` keyword, as a value
 * or a key: a `model` enum, const or default, a path parameter, a combinator branch, a
 * discriminator mapping. A spec recorded as listing no in-scope model must name none.
 */
export function listedModels(document: Json, inScopeIds: ReadonlySet<string>) {
	const found = new Set<string>();
	const note = (id: string) => inScopeIds.has(id) && found.add(id);
	const visit = (value: Json, parent?: string) => {
		if (typeof value === "string") note(value);
		else if (Array.isArray(value)) for (const item of value) visit(item);
		else if (isObject(value))
			for (const [key, item] of Object.entries(value)) {
				// Under `properties`, `example` names a field, not an example.
				if (parent !== "properties" && (key === "example" || key === "examples")) continue;
				note(key);
				visit(item, key);
			}
	};
	visit(document);
	return [...found].sort();
}

/**
 * Each model's own `input` schema in one spec. A `discriminator` on `model` or an
 * `allOf` of `if model const … then input` selects the model's branch; otherwise every model in
 * `SubmitRequest.model.enum` shares the request's `input`. A spec without a usable enum fails.
 */
export function modelInputs(document: JsonObject, path = "The spec") {
	const submit = schemaAt(document, "SubmitRequest");
	const properties = submit && isObject(submit.properties) ? submit.properties : undefined;
	const ids = specModels(document);
	if (!properties || !ids) throw new Error(`${path} has no usable SubmitRequest.model.enum.`);
	const branches = new Map<string, Json>();
	const schemas = isObject(document.components) ? document.components.schemas : undefined;
	for (const schema of isObject(schemas) ? Object.values(schemas) : []) {
		const discriminator = isObject(schema) ? schema.discriminator : undefined;
		if (!isObject(discriminator) || discriminator.propertyName !== "model") continue;
		const mapping = isObject(discriminator.mapping) ? discriminator.mapping : {};
		for (const [id, ref] of Object.entries(mapping)) {
			const branch = resolveRefs({ $ref: ref }, document);
			const input = isObject(branch) && isObject(branch.properties) && branch.properties.input;
			if (!input) throw new Error(`Branch ${String(ref)} has no input.`);
			branches.set(id, input);
		}
	}
	for (const condition of Array.isArray(submit?.allOf) ? submit.allOf : []) {
		const test = isObject(condition) && isObject(condition.if) ? condition.if : undefined;
		const testModel =
			test && isObject(test.properties) && isObject(test.properties.model)
				? test.properties.model.const
				: undefined;
		const then = isObject(condition) && isObject(condition.then) ? condition.then : undefined;
		const input = then && isObject(then.properties) ? then.properties.input : undefined;
		if (typeof testModel !== "string" || !input)
			throw new Error("SubmitRequest.allOf is not a per-model input branch.");
		if (branches.has(testModel)) throw new Error(`Two branches select ${testModel}.`);
		branches.set(testModel, input);
	}
	const shared = properties.input;
	const inputs = new Map<string, { input: Json; shared: boolean }>();
	for (const id of ids) {
		const input = branches.get(id) ?? shared;
		if (input === undefined) throw new Error(`${id} has no input schema.`);
		// A spec that lists several models without selecting a branch for this one documents
		// their union, not this model's own input.
		inputs.set(id, {
			input: resolveRefs(input, document),
			shared: !branches.has(id) && ids.length > 1,
		});
	}
	return inputs;
}

/**
 * The docs index digest, a manifest of every listed spec and, for in-scope IDs only, each
 * model's resolved `input` schema, stored once per distinct schema under its SHA-256. A spec
 * recorded as listing no in-scope model (non-model endpoints; out-of-scope music and voice
 * `Request` specs) is only digested, and fails once it names an in-scope ID outside an
 * example; any other spec without a usable model enum fails the projection.
 */
export function projectOpenApi(
	index: string,
	read: (path: string) => string,
	inScopeIds: ReadonlySet<string>,
	date: string,
	noModel: ReadonlySet<string> = new Set(record.openapi.noModelSpecs.paths),
) {
	const paths = indexedSpecs(index);
	const manifest = paths.map((path) => ({ path, sha256: sha256(read(path)) }));
	const models: Record<string, { input: string; spec: string; shared?: true }> = {};
	const schemas: Record<string, Json> = {};
	for (const path of paths) {
		// The Chinese specs are digested in the manifest but not projected.
		if (path.startsWith("/zh/")) continue;
		const document = JSON.parse(read(path)) as JsonObject;
		if (noModel.has(path)) {
			const listed = listedModels(document, inScopeIds);
			if (listed.length)
				throw new Error(
					`${path} is recorded as listing no in-scope model, but lists ${listed.join(", ")}.`,
				);
			continue;
		}
		for (const [id, { input, shared }] of modelInputs(document, path)) {
			if (!inScopeIds.has(id)) continue;
			if (models[id]) throw new Error(`${id} appears in ${models[id].spec} and ${path}.`);
			const digest = sha256(canonicalJson(input));
			schemas[digest] = input;
			models[id] = { input: digest, spec: path, ...(shared && { shared: true as const }) };
		}
	}
	return `${canonicalJson({
		date,
		index: { sha256: sha256(index), url: record.openapi.index },
		manifest,
		manifestSha256: sha256(manifest.map((file) => `${file.sha256}  ${file.path}\n`).join("")),
		models,
		schemas,
	})}\n`;
}

/**
 * The IDs whose OpenAPI input is projected: the pinned catalog's in-scope entries and the
 * recorded extra IDs, documented ledger IDs the pin lacks, so they still have a REST state.
 */
export function openApiScope(catalog: string, expected: SourceRecord = record) {
	const entries = (JSON.parse(catalog) as { entries: { model_id: string }[] }).entries;
	return new Set([...entries.map((entry) => entry.model_id), ...expected.openapi.extraIds.ids]);
}

/**
 * Projects a mirror of the upstream files after checking the catalog against its recorded
 * SHA-256. `read` takes a mirror-relative path.
 */
export function repin(read: (path: string) => string, expected: SourceRecord = record) {
	const upstream = read("capability-catalog.json");
	if (sha256(upstream) !== expected.catalog.upstreamSha256)
		throw new Error("The catalog does not match its recorded SHA-256.");
	const catalog = projectCatalog(upstream, expected.catalog.revision);
	const openapi = projectOpenApi(
		read("llms.txt"),
		(path) => read(`openapi${path}`),
		openApiScope(catalog, expected),
		expected.openapi.date,
		new Set(expected.openapi.noModelSpecs.paths),
	);
	return { catalog, openapi };
}

if (import.meta.main) {
	const mirror = process.argv[2];
	if (!mirror) throw new Error("Usage: bun scripts/media-catalog/project.ts <mirror-dir>");
	const { catalog, openapi } = repin((path) => readFileSync(join(mirror, path), "utf8"));
	const here = new URL("./sources/", import.meta.url);
	writeFileSync(new URL(record.catalog.file, here), catalog);
	writeFileSync(new URL(record.openapi.file, here), openapi);
	console.log(
		`catalog ${sha256(catalog)} (${catalog.length} bytes), openapi ${sha256(openapi)} (${openapi.length} bytes)`,
	);
}
