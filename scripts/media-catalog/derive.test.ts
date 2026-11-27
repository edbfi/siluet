import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import ledger from "../../docs/media-catalog.v1.json";
import { canonicalJson } from "../../src/lib/shared/media-catalog/canonical";
import { d4States } from "../../src/lib/shared/media-catalog/filtering";
import type { ReviewedRule, Schema } from "../../src/lib/shared/media-catalog/schema";
import {
	type CatalogEntry,
	countNotes,
	crossCheck,
	deriveRow,
	deriveRows,
	isMedia,
	type RowSources,
	renderRows,
	rowsPath,
} from "./derive";
import { sha256 } from "./project";
import { verifiedOptions as optionsOf } from "./verified";

const committed = readFileSync(rowsPath, "utf8");
const rows = deriveRows();
const root = resolve(import.meta.dir, "../..");

/** Every file one module reaches through static imports and re-exports, type-only included. */
function staticImports(entry: string) {
	const reached = new Map<string, string[]>([[entry, [entry]]]);
	const queue = [entry];
	const resolveSpecifier = (from: string, specifier: string) => {
		const base = specifier.startsWith(".")
			? resolve(dirname(from), specifier)
			: specifier.startsWith("#lib/") || specifier.startsWith("$lib/")
				? join(root, "src/lib", specifier.slice(5))
				: null;
		if (!base) return null;
		for (const candidate of [base, `${base}.ts`, `${base}.js`, join(base, "index.ts")])
			if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
		throw new Error(`${relative(root, from)} imports ${specifier}, which does not resolve.`);
	};
	while (queue.length) {
		const file = queue.shift() as string;
		if (file.endsWith(".json")) continue;
		const source = readFileSync(file, "utf8")
			.replace(/\/\*[\s\S]*?\*\//g, "")
			.replace(/^\s*\/\/.*$/gm, "");
		for (const [, specifier] of source.matchAll(
			/(?:^|[;\s])(?:import|export)\s+(?:type\s+)?(?:[^"'`;]*?\sfrom\s+)?["']([^"']+)["']/g,
		)) {
			const target = resolveSpecifier(file, specifier);
			if (!target || reached.has(target)) continue;
			reached.set(target, [...(reached.get(file) as string[]), target]);
			queue.push(target);
		}
	}
	return reached;
}

// Generated projections, matched by pattern so projections added later are covered too.
const generated = [
	/^src\/lib\/shared\/media-catalog\/poyo-[^/]*\.json$/,
	/^src\/lib\/server\/providers\/poyo\/queue-schemas\.json$/,
];
const projections = (entry: string) =>
	[...staticImports(join(root, entry)).entries()]
		.filter(([file]) => generated.some((pattern) => pattern.test(relative(root, file))))
		.map(([, chain]) => chain.map((file) => relative(root, file)).join(" → "));

test("neither the deriver nor the verified options reach a generated projection", () => {
	// The walker sees through re-exports and type-only edges: the browser's formats reader
	// does reach its projection.
	expect(projections("src/lib/shared/media-catalog/poyo-formats.ts")).toEqual([
		"src/lib/shared/media-catalog/poyo-formats.ts → src/lib/shared/media-catalog/poyo-formats.json",
	]);
	expect(projections("scripts/media-catalog/derive.ts")).toEqual([]);
	expect(projections("scripts/media-catalog/verified.ts")).toEqual([]);
});

test("the rows derive whether the formats projection is missing or stale", () => {
	const run = (contents: string | null) => {
		const directory = mkdtempSync(join(tmpdir(), "siluet-derive-"));
		const plugin = join(directory, "formats-plugin.ts");
		writeFileSync(
			plugin,
			`Bun.plugin({ name: "formats", setup(build) { build.onLoad({ filter: /poyo-formats\\.json$/ }, () => { ${
				contents === null
					? 'throw new Error("poyo-formats.json is missing");'
					: `return { contents: ${JSON.stringify(contents)}, loader: "json" };`
			} }); } });`,
		);
		try {
			return Bun.spawnSync(
				[
					process.execPath,
					"--preload",
					plugin,
					"-e",
					'import { renderRows } from "./scripts/media-catalog/derive"; process.stdout.write(renderRows());',
				],
				{ cwd: root },
			);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	};
	for (const contents of [null, '{"rows":[]}']) {
		const { exitCode, stdout } = run(contents);
		expect(exitCode).toBe(0);
		expect(stdout.toString()).toBe(committed);
	}
});

test("derivation reproduces the committed rows byte for byte, canonical and under 500 KB", () => {
	expect(renderRows()).toBe(committed);
	expect(`${canonicalJson(JSON.parse(committed))}\n`).toBe(committed);
	expect(Buffer.byteLength(committed)).toBeLessThan(500 * 1024);
});

const documented = ledger.providers.poyo.rows.filter((row) => row.contract === "documented");

test("each documented Poyo.ai ID has one row whose D4 state is the ledger's", () => {
	expect(rows.map(({ model }) => model).sort()).toEqual(
		documented.flatMap((row) => row.ids).sort(),
	);
	for (const row of documented)
		for (const model of row.ids)
			expect(rows.find((derived) => derived.model === model)?.d4.d4 as string).toBe(
				row.d4 as string,
			);
});

test("the migrated ledger matches the inventory query: 48 closed-absent, 31 declared, 89 open-absent", () => {
	// jq '[.providers.poyo.rows[] | select(.contract == "documented") | . as $r | .ids[]
	//   | "\($r.d4 // "-")/\($r.catalogD4 // "-")"] | group_by(.) | map({(.[0]): length}) | add'
	const groups: Record<string, number> = {};
	for (const row of documented)
		for (const _ of row.ids) {
			const key = `${row.d4 ?? "-"}/${("catalogD4" in row && row.catalogD4) || "-"}`;
			groups[key] = (groups[key] ?? 0) + 1;
		}
	expect(groups).toEqual({ "closed-absent/-": 48, "declared/-": 31, "open-absent/-": 89 });
	for (const provider of ["poyo", "toapis"] as const)
		for (const row of ledger.providers[provider].rows) {
			const fields = row as { d4?: string; catalogD4?: string };
			expect([...d4States, undefined]).toContain(fields.d4 as never);
			if (fields.catalogD4 !== undefined) {
				expect(fields.catalogD4).toBe("conflict");
				expect(fields.d4).toBe("contradiction");
			}
		}
});

test("the Gemini Omni Flash rows close in the catalog and stay open in the API schema", () => {
	for (const model of ["gemini-omni-1.1-flash", "gemini-omni-1.2-flash"])
		expect(rows.find((row) => row.model === model)?.d4).toEqual({
			d4: "closed-absent",
			closedBy: "catalog",
		});
	expect(rows.find((row) => row.model === "poyo-ai/image-translator")?.d4).toEqual({
		d4: "closed-absent",
		closedBy: "api",
	});
	// Pinned at ec73207, both Ideogram v4.6 IDs close in the catalog and the API schema.
	for (const model of ["ideogram-v4.6", "ideogram-v4.6-edit"]) {
		const row = rows.find((derived) => derived.model === model);
		expect(row?.d4).toEqual({ d4: "closed-absent", closedBy: "both" });
		expect(row?.catalog).toMatch(/^[0-9a-f]{64}$/);
		expect(row?.pending.join()).not.toContain("not in the pinned catalog");
	}
});

test("the eight IDs added at ec73207 without an OpenAPI spec take the catalog's state alone", () => {
	const catalogOnly = rows.filter((row) => row.d4.catalogOnly).map((row) => row.model);
	expect(catalogOnly).toEqual([
		"ltx-2.5-fast",
		"ltx-2.5-pro",
		"recraft-v4.1",
		"recraft-v4.1-flash",
		"recraft-v4.1-pro",
		"recraft-v4.1-pro-vector",
		"recraft-v4.1-vector",
		"sync-lipsync-3",
	]);
	for (const model of catalogOnly)
		expect(rows.find((row) => row.model === model)).toMatchObject({
			d4: { d4: "closed-absent", closedBy: "catalog", catalogOnly: true },
			rest: null,
			spec: null,
		});
	// Recraft's colour palette is a creator option, not a media input: an array of RGB objects
	// is a nested object outside the validator, so it has no covered path yet.
	const recraft = rows.find((row) => row.model === "recraft-v4.1");
	expect(recraft?.inputs).toEqual([]);
	expect(recraft?.options.find((option) => option.field === "colors")).toMatchObject({
		kind: "construct",
		gap: { state: "pending" },
	});
	// Bria RMBG 3.0 has a spec, and both sources close its input.
	expect(rows.find((row) => row.model === "bria-rmbg-3.0")?.d4).toEqual({
		d4: "closed-absent",
		closedBy: "both",
	});
});

test("a documented ID the pinned catalog lacks is pending and takes the REST state alone", () => {
	const row = deriveRow(
		{ media: "image", route: "POST /api/generate/submit", operations: ["text-to-image"] },
		"ideogram-v4.6",
		undefined,
	);
	expect(row).toMatchObject({
		d4: { d4: "closed-absent", closedBy: "api" },
		catalog: null,
		basis: null,
	});
	expect(row.pending[0]).toBe("not in the pinned catalog");
});

test("verified representatives are cross-checked and never rewritten", () => {
	expect(() => crossCheck(rows)).not.toThrow();
	const tampered = optionsOf(rows).map((entry) =>
		entry.key.model === "seedream-5.5"
			? { ...entry, offered: { ...entry.offered, resolution: { values: ["1K", "4K"] } } }
			: entry,
	);
	expect(() => crossCheck(rows, tampered)).toThrow('seedream-5.5 resolution offers ["4K"]');
	const undeclared = rows.map((row) =>
		row.model === "h3-max" ? { ...row, d4: { d4: "open-absent" as const } } : row,
	);
	expect(() => crossCheck(undeclared)).toThrow("h3-max disagrees");
});

test("derived rows record constructs, contradictions and unknowns, and nothing queues", () => {
	const option = (model: string, field: string) =>
		rows.find((row) => row.model === model)?.options.find((item) => item.field === field);
	expect(option("gpt-image-2.6-fixed", "resolution")?.gap).toMatchObject({
		state: "unknown",
		question: 7,
	});
	expect(option("gpt-image-2.6-fixed", "resolution")?.default).toEqual({
		state: "unresolved",
		reason: "one source",
	});
	for (const field of ["protect_text", "synthesis_on_image", "translate_on_image"])
		expect(option("poyo-ai/image-translator", field)?.gap?.question).toBe(7);
	expect(option("seedream-4.5", "n")?.disputed).toEqual({
		catalog: { minimum: 1, maximum: 15 },
		api: { minimum: 1, maximum: 6 },
	});
	expect(option("flux-3-klein", "size")?.kind).toBe("rule");
	expect(option("flux-dev", "size")?.gap).toEqual({ state: "pending", reason: "uses oneOf" });
	expect(option("mai-image-2.7", "size")?.gap?.reason).toStartWith("uses pattern");
	expect(option("minimax-h3-image", "size")?.gap?.reason).toBe(
		"domain only in prose: typing rule with G6",
	);
	expect(option("kling-2.5-turbo-pro", "aspect_ratio")?.gap?.question).toBe(11);
	expect(option("seedance-2.5", "prompt")?.gap).toMatchObject({ question: 10 });
	// At ec73207 the catalog lists kling-4.0's dynamic_range and both sources agree on 4k.
	expect(option("kling-4.0", "dynamic_range")).toBeDefined();
	expect(option("kling-4.0", "dynamic_range")?.gap?.question).not.toBe(7);
	for (const model of ["kling-4.0", "seedance-2.5"])
		expect(option(model, "resolution")?.disputed).toBeUndefined();
	expect(rows.find((row) => row.model === "kling-4.0")?.pending).toEqual([
		// ec73207 adds `dynamic_range: const hdr` in an `allOf` branch.
		"schema uses oneOf in allOf, items in allOf, const in allOf, x-server-validation",
	]);
	expect(rows.find((row) => row.model === "vidu-q4")?.pending).toEqual([]);
	expect(JSON.stringify(rows)).not.toMatch(/"queue"|"eligible"/);
});

test("a verified enum choice needs documented values", () => {
	const valueless = rows.map((row) =>
		row.model === "seedream-5.5"
			? {
					...row,
					options: row.options.map((option) =>
						option.field === "resolution" ? { ...option, domain: {} } : option,
					),
				}
			: row,
	);
	expect(() => crossCheck(valueless)).toThrow("seedream-5.5 resolution offers");
});

describe("fixture rows", () => {
	const ledgerRow = {
		media: "image",
		route: "POST /api/generate/submit",
		operations: ["text-to-image"],
	};
	const entry = (input_schema: Schema, extra: Partial<CatalogEntry> = {}): CatalogEntry => ({
		model_id: "fixture",
		category: "text2img",
		status: "stable",
		service_type: "generate",
		execution_mode: "async",
		input_schema,
		billing: { type: "fixed" },
		...extra,
	});
	const prompt = { type: "string", maxLength: 100 };
	const declared = {
		type: "object",
		required: ["prompt"],
		properties: { prompt, enable_safety_checker: { type: "boolean" } },
	};
	const none: RowSources = { models: {}, schemas: {}, rules: [] };
	const withApi = (input: Schema): RowSources => ({
		models: { fixture: { input: "api", spec: "/fixture.json" } },
		schemas: { api: input },
		rules: [],
	});

	test("a declared fixture with a valid minimal request has nothing pending", () => {
		expect(deriveRow(ledgerRow, "fixture", entry(declared), none)).toMatchObject({
			d4: { d4: "declared", catalogOnly: true },
			pending: [],
		});
	});
	test("no valid minimal request keeps the row pending", () => {
		const impossible = {
			...declared,
			properties: {
				...declared.properties,
				prompt: { type: "string", minLength: 5, maxLength: 2 },
			},
		};
		expect(deriveRow(ledgerRow, "fixture", entry(impossible), none).pending).toEqual([
			"no valid minimal request: catalog: prompt is longer than 2 characters",
		]);
	});
	test("an unsupported construct on a required input keeps the row pending", () => {
		const constant = {
			...declared,
			properties: { ...declared.properties, prompt: { type: "string", const: "x" } },
		};
		expect(deriveRow(ledgerRow, "fixture", entry(constant), none).pending).toEqual([
			"required input uses prompt const",
		]);
	});
	test("a route other than generate/async keeps the row pending", () => {
		expect(
			deriveRow(ledgerRow, "fixture", entry(declared, { execution_mode: "sync" }), none).pending,
		).toEqual(["service generate/sync"]);
		expect(
			deriveRow(ledgerRow, "fixture", entry(declared, { service_type: "chat" }), none).pending,
		).toEqual(["service chat/async"]);
	});
	test("a D4 contradiction keeps the row pending", () => {
		const closedApi = {
			type: "object",
			required: ["prompt"],
			properties: { prompt },
			additionalProperties: false,
		};
		const row = deriveRow(ledgerRow, "fixture", entry(declared), withApi(closedApi));
		expect(row.d4).toEqual({ d4: "contradiction" });
		expect(row.pending).toEqual(["D4 contradiction"]);
	});
	test("n is a count only under the description convention", () => {
		const counted = (description: string) =>
			deriveRow(
				ledgerRow,
				"fixture",
				entry({
					...declared,
					properties: {
						...declared.properties,
						n: { type: "integer", minimum: 1, maximum: 4, description },
					},
				}),
				none,
			).options.find((option) => option.field === "n")?.kind;
		expect(counted("Number of output images.")).toBe("count");
		expect(counted("Number of images to generate (1-4).")).toBe("count");
		expect(counted("Noise steps.")).toBe("integer");
	});

	const sized = {
		...declared,
		properties: {
			...declared.properties,
			size: {
				type: "string",
				description: "A ratio, or exact pixels.",
				oneOf: [{ enum: ["1:1"] }, { pattern: "^\\d+x\\d+$" }],
			},
		},
	};
	const sizeRule = (source: "catalog" | "rest", quote = "exact pixels"): ReviewedRule => ({
		id: `fixture-size-${source}`,
		model: "fixture",
		source,
		schemaSha256: sha256(canonicalJson(sized)),
		field: "size",
		constructs: ["oneOf"],
		quote,
		check: () => null,
	});
	const ruled = (...rules: ReviewedRule[]) =>
		deriveRow(ledgerRow, "fixture", entry(sized), { ...none, rules }).options.find(
			(option) => option.field === "size",
		);
	test("a rule reviewed for the REST input never covers the catalog's construct", () => {
		expect(ruled(sizeRule("catalog"))).toMatchObject({ kind: "rule" });
		expect(ruled(sizeRule("catalog"))?.gap).toBeUndefined();
		expect(ruled(sizeRule("rest"))).toMatchObject({
			kind: "construct",
			gap: { state: "pending", reason: "uses oneOf" },
		});
	});
	test("a rule or an override whose quote its field's description lacks fails derivation", () => {
		expect(() => ruled(sizeRule("catalog", "exact pixels only"))).toThrow(
			"fixture-size-catalog quotes text its field's description lacks",
		);
		const override = (quote: string, field = "size"): RowSources => ({
			...none,
			rules: [sizeRule("catalog")],
			overrides: [
				{
					model: "fixture",
					operation: "text-to-image",
					field,
					schemaSha256: sha256(canonicalJson(sized)),
					excludes: ["1:1"],
					quote,
				},
			],
		});
		expect(() => deriveRow(ledgerRow, "fixture", entry(sized), override("A ratio"))).not.toThrow();
		expect(() => deriveRow(ledgerRow, "fixture", entry(sized), override("A square"))).toThrow(
			"The fixture size override quotes text its field's description lacks",
		);
		expect(() =>
			deriveRow(ledgerRow, "fixture", entry(sized), override("A ratio", "aspect")),
		).toThrow("The fixture aspect override quotes text its field's description lacks");
	});
	test("a reviewed count note whose description changed fails derivation", () => {
		const counted = (description: string) =>
			deriveRow(
				ledgerRow,
				"kling-4.0-image",
				entry({
					...declared,
					properties: {
						...declared.properties,
						n: { type: "integer", minimum: 1, maximum: 10, description },
					},
				}),
				none,
			);
		expect(counted(countNotes["kling-4.0-image n"]).options[0]).toMatchObject({
			field: "n",
			kind: "count",
		});
		expect(() => counted("Number of images, from 1 to 10.")).toThrow(
			"The kling-4.0-image n count note no longer matches its description",
		);
	});
	test("an output format Gallery cannot save, or one without a typed enum, is pending with its reason", () => {
		const formatted = (output_format: Schema) =>
			deriveRow(
				ledgerRow,
				"fixture",
				entry({ ...declared, properties: { ...declared.properties, output_format } }),
				none,
			).options.find((option) => option.field === "output_format")?.gap;
		expect(formatted({ type: "string", enum: ["gif"] })).toEqual({
			state: "pending",
			reason: "Gallery saves none of its output formats",
		});
		expect(formatted({ type: "integer", enum: [1, 2] })).toEqual({
			state: "pending",
			reason: "output format is not a typed enum",
		});
		expect(formatted({ type: "string", enum: ["png", "gif"] })).toBeUndefined();
	});
	test("a field only one source owns is never found on the other's prototype", () => {
		const closed = { ...declared, additionalProperties: false };
		const own = (properties: string) =>
			JSON.parse(
				`{"type":"object","required":["prompt"],"properties":{"prompt":{"type":"string","maxLength":100},${properties}}}`,
			) as Schema;
		const apiOnly = deriveRow(
			ledgerRow,
			"fixture",
			entry(closed),
			withApi(own('"constructor":{"type":"string","enum":["a"]}')),
		);
		expect(apiOnly.options.find((option) => option.field === "constructor")).toMatchObject({
			kind: "enum",
			gap: { state: "unknown", question: 7 },
		});
		const catalogOnly = deriveRow(
			ledgerRow,
			"fixture",
			entry(own('"valueOf":{"type":"string","enum":["a"]}')),
			withApi({
				type: "object",
				required: ["prompt"],
				properties: { prompt },
				additionalProperties: false,
			}),
		);
		expect(catalogOnly.options.find((option) => option.field === "valueOf")).toMatchObject({
			kind: "enum",
			gap: { state: "unknown", question: 7 },
		});
	});
});

test("an ID documented in two ledger rows fails the derivation", () => {
	const documented = ledger.providers.poyo.rows.filter((row) => row.contract === "documented");
	expect(() => deriveRows([...documented, documented[0]])).toThrow(
		`${documented[0].ids[0]} is documented in more than one ledger row.`,
	);
});

test("an array of URIs is a media input whatever its name; an array of other values is an option", () => {
	const uris = { type: "array", items: { type: "string", format: "uri" } };
	expect(isMedia("images", uris)).toBe(true);
	expect(isMedia("image_urls", { type: "array", items: { type: "string" } })).toBe(true);
	expect(isMedia("colors", { type: "array", items: { type: "object" } })).toBe(false);
});
