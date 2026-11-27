import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import ledger from "../../docs/media-catalog.v1.json";
import { reviewedOverrides } from "../../src/lib/shared/media-catalog/rules";
import {
	assignment,
	type CoverageItem,
	coverage,
	coverageStates,
	expandKeys,
	inventoryPath,
	offerGap,
	optionObligations,
	renderInventory,
	summary,
	tally,
} from "./coverage";
import { type DerivedOption, type DerivedRow, deriveRows } from "./derive";
import { verifiedOptions as optionsOf } from "./verified";

const rows = deriveRows();
const verifiedOptions = optionsOf(rows);
const result = coverage({ rows });
const keyOf = (item: CoverageItem) =>
	JSON.stringify([item.provider, item.model, item.route, item.operation, item.option, item.values]);

test("every expanded key and option has exactly one state", () => {
	const seen = new Set<string>();
	for (const item of result.items) {
		expect(coverageStates).toContain(item.state);
		expect(seen.has(keyOf(item))).toBe(false);
		seen.add(keyOf(item));
		if (item.state === "unknown") expect(item.question).toBeDefined();
		expect(item.reason).toBeTruthy();
	}
	const keys = result.items.filter((item) => item.option === undefined);
	expect(keys).toHaveLength(expandKeys().length);
	expect(keys).toHaveLength(663);
});

test("a route alias adds no key", () => {
	const imagine = expandKeys().filter((key) => key.operation === "imagine");
	expect(imagine).toEqual([
		{
			provider: "toapis",
			model: "midjourney",
			route: "POST /v1/midjourney/generations/imagine",
			operation: "imagine",
			verified: false,
		},
	]);
	const alias = ledger.providers.toapis.rows.find((row) => "aliases" in row);
	expect(alias && "aliases" in alias && alias.aliases).toEqual(["POST /v1/midjourney/generations"]);
	expect(expandKeys().some((key) => key.route === "POST /v1/midjourney/generations")).toBe(false);
});

test("the tag-blocking count matches the ledger", () => {
	const keys = expandKeys();
	const shipped = keys.filter((key) => key.verified);
	expect(shipped).toHaveLength(11);
	const supportKeys = (["poyo", "toapis"] as const).flatMap((provider) =>
		ledger.providers[provider].rows.flatMap((row) =>
			Object.keys(("support" in row && row.support) || {}).flatMap((operation) =>
				row.ids.map((model) => `${provider} ${model} ${operation}`),
			),
		),
	);
	expect(shipped.map((key) => `${key.provider} ${key.model} ${key.operation}`).sort()).toEqual(
		supportKeys.sort(),
	);
	// Nothing is contract-covered or provider-unsupported before G4, so every key and option
	// without a verified path blocks the tag.
	const unblocked = result.items.filter((item) => item.state === "verified").length;
	expect(result.tagBlocking).toBe(result.items.length - unblocked);
	expect(result.blocking.unknownWithoutQuestion).toBe(0);
	expect(result.blocking.unsupportedWithoutEvidence).toBe(0);
	expect(
		result.items.filter((item) => item.option === undefined && item.state === "unknown"),
	).toHaveLength(4);
	expect(result.blocking.envelope).toBe(1);
	expect(result.items.find((item) => item.envelope)?.reason).toBe(
		"Siluet's 4000-byte envelope excludes the documented 50000 characters",
	);
});

test("the buckets count unsupported pairs with evidence as unblocked", () => {
	const key = {
		provider: "poyo",
		model: "m",
		route: "POST /x",
		operation: "o",
		slice: "G4",
	} as const;
	expect(
		tally([
			{ ...key, state: "unsupported", reason: "refused", evidence: "https://docs.example/x" },
			{ ...key, state: "unsupported", reason: "said so" },
			{ ...key, state: "unknown", reason: "no evidence" },
			{ ...key, state: "contract-covered", reason: "row" },
		]),
	).toEqual({
		blocking: {
			envelope: 0,
			pending: 0,
			withoutPath: 0,
			unsupportedWithoutEvidence: 1,
			unknownWithoutQuestion: 1,
		},
		tagBlocking: 2,
	});
});

test("removing a genuine creator option from the composer leaves a blocker", () => {
	const without = verifiedOptions.map((entry) => {
		if (entry.key.model !== "seedream-5.5" || entry.key.provider !== "poyo") return entry;
		const { background: _removed, ...offered } = entry.offered;
		return { ...entry, offered };
	});
	const removed = coverage({ rows, offered: without });
	expect(removed.tagBlocking).toBe(result.tagBlocking + 2);
	const narrowed = verifiedOptions.map((entry) =>
		entry.key.model === "z-image" && entry.key.operation === "text-to-image"
			? { ...entry, offered: { ...entry.offered, size: { values: ["1:1"] } } }
			: entry,
	);
	expect(coverage({ rows, offered: narrowed }).tagBlocking).toBe(result.tagBlocking + 1);
});

test("D4's fixed false, a pinned n: 1 and a fixed sentinel never block", () => {
	const options = result.items.filter((item) => item.option !== undefined);
	expect(options.some((item) => item.option === "enable_safety_checker")).toBe(false);
	// Seedream 5.5 has no `n`; Z-Image's verified rows offer every option they document.
	const verifiedRows = options.filter(
		(item) => item.provider === "poyo" && ["seedream-5.5", "z-image"].includes(item.model),
	);
	expect(
		verifiedRows
			.filter((item) => item.state !== "verified")
			.map((item) => [item.model, item.operation, item.option]),
	).toEqual([]);
	// A count whose only documented value is the pinned 1 adds no obligation, and a shared
	// count above 1 is the Phase 3 multi-output obligation, never `n: 1` itself.
	for (const item of options.filter((option) => option.option === "n"))
		expect(item.values).toMatch(/^\d+–(\d+|…)$/);
	expect(
		options.filter((item) => item.option === "n").every((item) => !item.values?.startsWith("1")),
	).toBe(true);
	// A fixed sentinel is a value, not a choice: a domain of only the sentinel the composer
	// sends leaves nothing to offer.
	expect(offerGap({ values: [-1] }, { values: [-1] })).toBeNull();
	expect(offerGap({ minimum: 5, maximum: 15 }, { minimum: 5, maximum: 10 })).toBe(
		"composer offers 5–10 of 5–15",
	);
	expect(offerGap({ maxLength: 1000 }, { maxBytes: 4000 })).toBeNull();
	expect(offerGap({ maxLength: 1001 }, { maxBytes: 4000 })).toStartWith(
		"Siluet's 4000-byte envelope",
	);
});

test("disputed values are their own unknown obligations", () => {
	const of = (model: string, option: string) =>
		result.items.filter(
			(item) =>
				item.model === model && item.option === option && item.operation === "text-to-image",
		);
	expect(
		of("seedream-4.5", "n").map(({ values, state, question }) => [values, state, question]),
	).toEqual([
		["2–6", "pending", undefined],
		["7–15", "unknown", 8],
	]);
	expect(of("gpt-image-2.6-flare", "output_format")[0]).toMatchObject({
		values: '"gif"',
		state: "unknown",
		question: 8,
	});
});

test("each key has an assignment and the inventory regenerates unchanged", () => {
	for (const key of expandKeys()) expect(assignment(key)).toBeTruthy();
	const inventory = readFileSync(inventoryPath, "utf8");
	expect(renderInventory(inventory, result.items)).toBe(inventory);
	expect(inventory.match(/<!-- catalog:coverage \S+ -->/g)).toHaveLength(4);
});

test("closed-absent image keys are assigned to G6, where their acknowledgement lands", () => {
	const closed = rows.filter((row) => row.media === "image" && row.d4.d4 === "closed-absent");
	expect(closed.length).toBeGreaterThan(0);
	for (const row of closed)
		for (const item of result.items.filter((candidate) => candidate.model === row.model))
			if (/^G[45]$/.test(assignment(item))) expect(item.slice).toBe("G6");
	const key = (model: string, operation: string) =>
		result.items.find(
			(item) => item.model === model && item.operation === operation && !item.option,
		);
	expect(key("gpt-image-2.6-fixed", "text-to-image")).toMatchObject({ slice: "G6", reason: "G6" });
	expect(key("bria-rmbg-3.0", "image-background-removal")).toMatchObject({ slice: "G6" });
	expect(key("flux-dev", "text-to-image")).toMatchObject({ slice: "G4" });
	expect(
		assignment(key("gpt-image-2.6-fixed", "text-to-image") as CoverageItem, "closed-absent"),
	).toBe("G6");
	// Video and non-engine assignments keep their labels whatever the D4 state.
	expect(
		assignment(
			{
				provider: "poyo",
				model: "m",
				route: "POST /api/generate/submit",
				operation: "text-to-video",
			},
			"closed-absent",
		),
	).toBe("G7");
});

test("a covered option leaves its 4K tier to G13 and its custom sizes to their own state", () => {
	const key = (model: string) => ({
		provider: "poyo" as const,
		model,
		route: "POST /api/generate/submit",
		operation: "text-to-image",
		verified: true,
	});
	const items = (model: string, values: readonly unknown[]) => {
		const row = rows.find((candidate) => candidate.model === model) as DerivedRow;
		const option = row.options.find(({ field }) => field === "size") as DerivedOption;
		return optionObligations(key(model), row, option, { size: { values } }, "G4").map(
			({ values, state, reason, question, envelope }) => [
				values,
				state,
				reason,
				question,
				envelope,
			],
		);
	};
	const listed = ["2K", "1:1", "4:3", "3:4", "16:9", "9:16", "3:2", "2:3", "21:9"];
	expect(items("seedream-4.5", listed)).toEqual([
		['"4K"', "pending", "G13: over Gallery's image limits", undefined, true],
		["custom sizes", "unknown", "custom sizes: no documented range or tier", 11, undefined],
		[
			listed.map((value) => JSON.stringify(value)).join(", "),
			"verified",
			"offered in full",
			undefined,
			undefined,
		],
	]);
	expect(items("flux-3-klein", ["1:1", "4:3", "3:4", "16:9", "9:16", "3:2", "2:3"])).toEqual([
		["custom sizes", "pending", "class not yet qualified: custom size", undefined, undefined],
		[
			'"1:1", "4:3", "3:4", "16:9", "9:16", "3:2", "2:3"',
			"verified",
			"offered in full",
			undefined,
			undefined,
		],
	]);
	// A row still in its slice keeps one item for the whole option.
	const pending = rows.find((candidate) => candidate.model === "seedream-4.5") as DerivedRow;
	expect(
		optionObligations(
			{ ...key("seedream-4.5"), verified: false },
			pending,
			pending.options.find(({ field }) => field === "size") as DerivedOption,
			undefined,
			"G4",
		),
	).toHaveLength(1);
});

const itemsOf = (model: string, option: string, operation?: string) =>
	result.items
		.filter(
			(item) =>
				item.model === model &&
				item.option === option &&
				(operation === undefined || item.operation === operation),
		)
		.map(({ values, state, question }) => [values, state, question]);

test("a count takes its maximum from its enum, and a count without one is unknown", () => {
	expect(itemsOf("gpt-4o-image", "n", "text-to-image")).toEqual([["2–4", "pending", undefined]]);
	expect(itemsOf("flux-dev", "n", "text-to-image")).toEqual([["2–…", "unknown", 11]]);
	expect(itemsOf("nano-banana-2", "n")).toEqual([]);
});

test("only the description convention or a reviewed note makes a count", () => {
	const option = (model: string, field: string) =>
		rows.find((row) => row.model === model)?.options.find((item) => item.field === field);
	expect(option("seedream-5.5-layerize", "max_images")?.kind).toBe("integer");
	expect(option("kling-4.0-image", "n")?.kind).toBe("count");
	expect(option("ideogram-vector-1.0/text-to-vector", "n")?.kind).toBe("count");
	expect(option("seedream-4.5", "n")?.kind).toBe("count");
});

test("a disputed range tail is its own unknown item on any option", () => {
	const key = {
		provider: "poyo",
		model: "fixture",
		route: "POST /api/generate/submit",
		operation: "text-to-video",
		verified: false,
	} as const;
	const row = { model: "fixture", catalog: null, pending: [] } as unknown as DerivedRow;
	const option = (
		field: string,
		kind: DerivedOption["kind"],
		catalog: object,
		api: object,
		domain: object,
	) =>
		({
			field,
			kind,
			domain,
			disputed: { catalog, api },
			default: { state: "resolved", value: 1 },
		}) as DerivedOption;
	const items = (o: DerivedOption) =>
		optionObligations(key, row, o, undefined, "G7").map(({ values, state, question }) => [
			values,
			state,
			question,
		]);
	expect(
		items(
			option(
				"duration",
				"integer",
				{ minimum: 3, maximum: 15 },
				{ minimum: 5, maximum: 10 },
				{ minimum: 5, maximum: 10 },
			),
		),
	).toEqual([
		["3–4", "unknown", 8],
		["11–15", "unknown", 8],
		["5–10", "pending", undefined],
	]);
	expect(
		items(
			option("prompt", "free-text", { maxLength: 5000 }, { maxLength: 2000 }, { maxLength: 2000 }),
		),
	).toEqual([
		["2001–5000 characters", "unknown", 8],
		["up to 2000 characters", "pending", undefined],
	]);
	expect(items(option("strength", "number", { maximum: 1 }, {}, { maximum: 1 }))).toEqual([
		["above 1", "unknown", 8],
		["…–1", "pending", undefined],
	]);
});

test("verified composer facts: Z-Image edit offers size, and H3 Max text mode excludes adaptive", () => {
	expect(itemsOf("z-image", "size", "reference-image-edit")).toEqual([
		['"1:1", "4:3", "3:4", "16:9", "9:16"', "verified", undefined],
	]);
	expect(itemsOf("h3-max", "aspect_ratio", "text-to-video")).toEqual([
		['"21:9", "16:9", "4:3", "1:1", "3:4", "9:16"', "verified", undefined],
	]);
	const h3 = rows.find((row) => row.model === "h3-max");
	const override = reviewedOverrides.find((item) => item.model === "h3-max");
	expect(override).toMatchObject({
		operation: "text-to-video",
		field: "aspect_ratio",
		excludes: ["adaptive"],
		schemaSha256: h3?.catalog,
	});
	expect(override?.quote).toBe("Text mode defaults to 16:9 and does not accept adaptive.");
	// A stale hash no longer narrows the row.
	const stale = coverage({
		rows: rows.map((row) => (row.model === "h3-max" ? { ...row, catalog: "0".repeat(64) } : row)),
	});
	expect(
		stale.items.find(
			(item) =>
				item.model === "h3-max" &&
				item.option === "aspect_ratio" &&
				item.operation === "text-to-video",
		)?.values,
	).toContain('"adaptive"');
});

test("the summary reports ToAPIs placeholders apart from Poyo.ai option obligations", () => {
	const placeholders = result.items.filter((item) => item.option === "*");
	expect(placeholders).toHaveLength(6);
	expect(placeholders.every((item) => item.provider === "toapis")).toBe(true);
	const poyo = result.items.filter((item) => item.option !== undefined && item.provider === "poyo");
	const text = summary(result.items);
	expect(text).toContain(`Option obligations of the derived Poyo.ai rows: ${poyo.length};`);
	expect(text).toContain(
		"The 6 verified ToAPIs operations each add one placeholder item until their page descriptors type their options (G10a, G11a).",
	);
});

test("the operations table sorts labels by code unit", () => {
	const table = renderInventory(readFileSync(inventoryPath, "utf8"), result.items);
	expect(table.indexOf("| P3 · GIF and SVG output |")).toBeLessThan(
		table.indexOf("| P3 · audio and avatar inputs |"),
	);
});

test("a count passes through its option's gap and its row's pending reasons first", () => {
	expect(itemsOf("ideogram-v4.6", "n", "text-to-image")).toEqual([["2–8", "pending", undefined]]);
	const reasons = (model: string) =>
		result.items
			.filter((item) => item.model === model && item.option === "n")
			.map(({ reason }) => reason);
	expect(reasons("ideogram-v4.6")).toEqual(["P3 · multi-output and image sets"]);
	for (const model of ["ideogram-v4.5-edit", "ideogram-v4.6-edit"])
		for (const reason of reasons(model))
			expect(reason).toStartWith(
				(rows.find((row) => row.model === model) as DerivedRow).pending.join("; "),
			);
	const key = {
		provider: "poyo",
		model: "fixture",
		route: "POST /api/generate/submit",
		operation: "text-to-image",
		verified: false,
	} as const;
	const count = (domain: object, gap?: DerivedOption["gap"]) =>
		({
			field: "n",
			kind: "count",
			domain,
			default: { state: "resolved", value: 1 },
			...(gap && { gap }),
		}) as DerivedOption;
	const items = (row: object, option: DerivedOption) =>
		optionObligations(
			key,
			{ model: "fixture", catalog: null, pending: [], ...row } as unknown as DerivedRow,
			option,
			undefined,
			"G7",
		).map(({ values, state, reason, question }) => [values, state, reason, question]);
	const onlyCatalog = {
		state: "unknown",
		reason: "only the catalog lists it",
		question: 7,
	} as const;
	expect(items({}, count({ maximum: 4 }, onlyCatalog))).toEqual([
		["2–4", "unknown", "only the catalog lists it", 7],
	]);
	expect(items({ pending: ["schema uses const in allOf"] }, count({}))).toEqual([
		["2–…", "pending", "schema uses const in allOf", undefined],
	]);
	// A pinned `n: 1` still adds nothing, whatever blocks the row.
	expect(items({ pending: ["D4 unknown"] }, count({ values: [1] }, onlyCatalog))).toEqual([]);
});
