import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { canonicalJson } from "../../src/lib/shared/media-catalog/canonical";
import { reviewedRules } from "../../src/lib/shared/media-catalog/rules";
import { type Schema, validateBody } from "../../src/lib/shared/media-catalog/schema";
import { type DerivedRow, deriveRows } from "./derive";
import { pickerRows } from "./picker";
import { sha256 } from "./project";
import {
	queuePath,
	queueProjection,
	queueRow,
	queueSchemasPath,
	renderQueue,
	renderQueueSchemas,
} from "./queue";
import record from "./sources/sources.json";

const rows = deriveRows();
const projection = queueProjection(rows);
const row = (model: string) => projection.rows.find((entry) => entry.key.model === model);
const pending = (model: string) => projection.pending.find((entry) => entry.model === model);

test("both queue projections reproduce byte for byte, canonical and small", () => {
	for (const [path, render] of [
		[queuePath, renderQueue],
		[queueSchemasPath, renderQueueSchemas],
	] as const) {
		const committed = readFileSync(path, "utf8");
		expect(render()).toBe(committed);
		expect(`${canonicalJson(JSON.parse(committed))}\n`).toBe(committed);
		expect(Buffer.byteLength(committed)).toBeLessThan(500 * 1024);
	}
	expect(Buffer.byteLength(readFileSync(queuePath))).toBeLessThan(32 * 1024);
});

test("seventeen text-to-image rows queue: the plan's firm set", () => {
	expect(projection.rows.map(({ key }) => key.model)).toEqual([
		"flux-3-klein",
		"flux-dev",
		"flux-schnell",
		"gpt-4o-image",
		"gpt-image-1.5",
		"grok-imagine-image-2.0",
		"grok-imagine-image-quality",
		"kling-o3-image",
		"nano-banana-2",
		"nano-banana-pro",
		"qwen-image-2.1",
		"seedream-4",
		"seedream-4.5",
		"seedream-5.0-flash",
		"seedream-5.0-lite",
		"wan-2.7-image",
		"wan-2.7-image-pro",
	]);
	// Five declared and twelve open-absent.
	const states = projection.rows.map(({ d4 }) => d4.d4);
	expect(states.filter((state) => state === "declared")).toHaveLength(5);
	expect(states.filter((state) => state === "open-absent")).toHaveLength(12);
	for (const { key } of projection.rows)
		expect(key).toEqual({
			provider: "poyo",
			model: key.model,
			route: "POST /api/generate/submit",
			operation: "text-to-image",
		});
});

test("an unqualified class keeps the row pending with its class", () => {
	const flux = rows.find((row) => row.model === "flux-dev") as DerivedRow;
	const numbered: DerivedRow = {
		...flux,
		options: [
			...flux.options,
			{
				field: "guidance",
				kind: "number",
				domain: { minimum: 0, maximum: 10 },
				default: { state: "resolved", value: 3 },
			},
		],
	};
	expect(queueRow(numbered)).toBe("class not yet qualified: number");
	expect(pending("nano-banana-pro")).toBeUndefined();
	// Verified representatives keep their shipped paths; rows pending in derivation stay so.
	expect(row("seedream-5.5")).toBeUndefined();
	expect(row("z-image")).toBeUndefined();
	expect(row("flux-2-pro")).toBeUndefined();
});

test("Seedream 4.5 and 5.0 Lite listed sizes qualify as an enum, 4.5's 4K included", () => {
	expect(row("seedream-4.5")?.fields.find((field) => field.wire === "size")).toEqual({
		wire: "size",
		kind: "enum",
		values: ["2K", "4K", "1:1", "4:3", "3:4", "16:9", "9:16", "3:2", "2:3", "21:9"],
		preselect: "1:1",
	});
	expect(row("seedream-5.0-lite")?.fields.find((field) => field.wire === "size")?.values).toContain(
		"3K",
	);
});

test("flux-3-klein queues with its ratios while its custom size stays unqualified", () => {
	const klein = row("flux-3-klein");
	expect(klein?.fields.find((field) => field.wire === "size")?.values).toEqual([
		"1:1",
		"4:3",
		"3:4",
		"16:9",
		"9:16",
		"3:2",
		"2:3",
	]);
	expect(klein?.fields.find((field) => field.wire === "resolution")?.values).toEqual([
		"1K",
		"2K",
		"4K",
	]);
	expect(klein?.count).toBe(1);
});

test("the pinned n: 1 and the D4 field are fixed, never options: flux-dev queues without booleans or integers", () => {
	const flux = row("flux-dev");
	expect(flux?.fields.map((field) => field.wire)).toEqual(["output_format"]);
	expect(flux).toMatchObject({ count: 1, d4: { d4: "open-absent" } });
	for (const entry of projection.rows) {
		expect(entry.fields.some((field) => field.wire === "n")).toBe(false);
		expect(entry.fields.some((field) => field.wire === "enable_safety_checker")).toBe(false);
	}
	expect(row("seedream-5.0-flash")?.count).toBeNull();
});

test("each row carries its prompt limits, formats, combinations, rate key and contract digest", () => {
	expect(row("gpt-4o-image")?.prompt).toEqual({ min: 1, max: 1000, documented: true });
	// Undocumented limits take Siluet's 5,000-code-point image envelope.
	expect(row("flux-dev")?.prompt).toEqual({ min: 1, max: 5000, documented: false });
	expect(row("flux-dev")?.fields.find((field) => field.wire === "output_format")).toEqual({
		wire: "output_format",
		kind: "enum",
		values: ["jpeg", "png"],
		preselect: "png",
	});
	expect(row("gpt-4o-image")?.formats).toBeNull();
	expect(row("kling-o3-image")?.formats).toEqual(["jpeg", "png", "webp"]);
	for (const entry of projection.rows) {
		expect(entry.rateKey).toBe(entry.key.model);
		expect(entry.gallery).toBe(true);
		const { contract, ...rest } = entry;
		expect(contract).toBe(sha256(canonicalJson(rest)));
	}
	expect(projection.revision).toMatch(/^[0-9a-f]{40}$/);
	// Review dates the schema from the sources record, never from a literal.
	expect(projection.revision).toBe(record.catalog.revision);
	expect(projection.publishedAt).toBe(record.catalog.publishedAt);
});

test("the projection carries qwen-image-2.1's combination rule once it queues", () => {
	const qwen = rows.find((candidate) => candidate.model === "qwen-image-2.1") as DerivedRow;
	expect(qwen.combinations).toEqual([
		{ when: { background: "transparent" }, refuses: { output_format: ["jpeg"] } },
	]);
	// Every combination a queue row carries names two of its own fields.
	for (const entry of projection.rows)
		for (const rule of entry.combinations) {
			const names = [...Object.keys(rule.when), ...Object.keys(rule.refuses)];
			for (const name of names)
				expect(entry.fields.some((field) => field.wire === name)).toBe(true);
		}
});

test("each row's preselected body validates against both of its pinned schemas", () => {
	const schemas = JSON.parse(readFileSync(queueSchemasPath, "utf8")) as {
		rows: Record<string, { catalog: string; rest: string | null }>;
		schemas: Record<string, Schema>;
	};
	for (const entry of projection.rows) {
		const bound = schemas.rows[`${entry.key.model} ${entry.key.operation}`];
		expect(bound).toEqual(entry.schemas);
		const body = {
			prompt: "A".repeat(entry.prompt.min),
			...Object.fromEntries(
				entry.fields
					.filter((field) => !field.optional)
					.map((field) => [field.wire, field.preselect]),
			),
			...(entry.count === 1 && { n: 1 }),
			enable_safety_checker: false,
		};
		const errors = validateBody(
			{
				catalog: { schema: schemas.schemas[bound.catalog], sha256: bound.catalog },
				rest: bound.rest ? { schema: schemas.schemas[bound.rest], sha256: bound.rest } : null,
			},
			body,
			reviewedRules,
		);
		expect([entry.key.model, errors]).toEqual([entry.key.model, []]);
	}
});

test("the picker separates Queue-eligible operations from Review-only rows", () => {
	const picker = pickerRows(rows);
	const flux = picker.find(({ model }) => model === "flux-dev");
	expect(flux?.queue).toEqual(["text-to-image"]);
	expect(picker.find(({ model }) => model === "flux-2-pro")?.queue).toBeUndefined();
	expect(picker.filter(({ queue }) => queue).map(({ model }) => model)).toEqual(
		projection.rows.map(({ key }) => key.model),
	);
	expect(picker.find(({ model }) => model === "nano-banana-pro")?.queue).toEqual(["text-to-image"]);
});

test("an output format Siluet cannot offer refuses the row with its reason, never drops the format", () => {
	const flux = rows.find((row) => row.model === "flux-dev") as DerivedRow;
	for (const [reason, plain] of [
		[
			"Gallery saves none of its output formats",
			"Gallery cannot save the image types this model offers",
		],
		[
			"output format is not a typed enum",
			"Siluet cannot read this model's output format option yet",
		],
	]) {
		const unsavable: DerivedRow = {
			...flux,
			options: flux.options.map((option) =>
				option.field === "output_format"
					? { ...option, gap: { state: "pending", reason } }
					: option,
			),
		};
		expect(queueRow(unsavable)).toBe(reason);
		// The picker names the format, not the slice.
		const listed = pickerRows([unsavable]).find(({ model }) => model === "flux-dev");
		expect(listed?.queue).toBeUndefined();
		expect(listed?.reason).toBe(plain);
	}
});

test("only D4 states the server accepts can queue: an open-absent-fixed row stays out", () => {
	const row = deriveRows().find((candidate) => candidate.model === "flux-dev") as DerivedRow;
	const fixed = { ...row, d4: { ...row.d4, d4: "open-absent-fixed" } } as DerivedRow;
	expect(queueProjection([row]).rows).toHaveLength(1);
	expect(queueProjection([fixed]).rows).toEqual([]);
});

test("a prompt whose limit still needs its model page read keeps the row pending", () => {
	const row = deriveRows().find((candidate) => candidate.model === "flux-dev") as DerivedRow;
	const unread = {
		...row,
		options: row.options.map((option) =>
			option.field === "prompt"
				? {
						...option,
						gap: { state: "pending" as const, reason: "no documented limit: read the model page" },
					}
				: option,
		),
	};
	expect(queueRow(unread)).toBe("no documented limit: read the model page");
});
