import { expect, test } from "bun:test";
import catalog from "../../../../scripts/media-catalog/sources/poyo-ec73207.json";
import openapi from "../../../../scripts/media-catalog/sources/poyo-openapi-2026-11-26.json";
import schemas from "../../server/providers/poyo/queue-schemas.json";
import { canonicalJson } from "../media-catalog/canonical";
import projection from "../media-catalog/poyo-queue.json";
import type { QueueRow } from "../media-catalog/queue-row";
import { reviewedRules } from "../media-catalog/rules";
import { type RowSchemas, type Schema, validateBody } from "../media-catalog/schema";
import {
	buildDerivedRequest,
	createDerivedDraft,
	type DerivedDraft,
	validateDerivedDraft,
} from "./derived";

const rows = projection.rows as unknown as QueueRow[];
const row = (model: string) => {
	const found = rows.find((entry) => entry.key.model === model);
	if (!found) throw new Error(`${model} is not a queue row.`);
	return found;
};
const prompt = "A lighthouse on a cliff at dusk";
const draft = (model: string, change: Partial<DerivedDraft> = {}): DerivedDraft => ({
	...createDerivedDraft(row(model)),
	prompt,
	...change,
});
const errors = (target: QueueRow, value: unknown) => {
	const result = validateDerivedDraft(target, value);
	return result.ok ? null : result.errors;
};

// A fresh fixture shaped like qwen-image-2.1's row, which queues once booleans and integers
// qualify: a combination rule, a boolean and an optional unbounded seed.
const qwen: QueueRow = {
	...row("seedream-5.0-flash"),
	key: { ...row("seedream-5.0-flash").key, model: "fixture-qwen" },
	prompt: { min: 1, max: 5000, documented: true },
	count: null,
	fields: [
		{ wire: "background", kind: "enum", values: ["opaque", "transparent"], preselect: "opaque" },
		{ wire: "output_format", kind: "enum", values: ["png", "webp", "jpeg"], preselect: "png" },
		{ wire: "prompt_extend", kind: "boolean", preselect: true },
		{ wire: "seed", kind: "integer", optional: true },
	],
	combinations: [{ when: { background: "transparent" }, refuses: { output_format: ["jpeg"] } }],
	d4: { d4: "declared" },
};

test("a new draft starts on each field's preselected value and leaves an optional seed out", () => {
	expect(createDerivedDraft(row("seedream-4.5"))).toEqual({
		model: "seedream-4.5",
		operation: "text-to-image",
		prompt: "",
		options: { size: "1:1" },
	});
	expect(createDerivedDraft(qwen).options).toEqual({
		background: "opaque",
		output_format: "png",
		prompt_extend: true,
	});
});

test("the draft takes only its own keys, its own fields and their offered values", () => {
	const ok = draft("kling-o3-image");
	expect(errors(row("kling-o3-image"), ok)).toBeNull();
	expect(errors(row("kling-o3-image"), { ...ok, extra: 1 })).toEqual({
		draft: "Choose an image model and its options again.",
	});
	expect(errors(row("kling-o3-image"), { ...ok, model: "kling-o3-image-edit" })).toEqual({
		draft: "Choose an image model and its options again.",
	});
	expect(errors(row("kling-o3-image"), { ...ok, options: { ...ok.options, n: 2 } })).toEqual({
		options: "Use only this model's options.",
	});
	// Every non-optional field is sent explicitly, so the draft must carry it.
	const { size: _size, ...withoutSize } = ok.options;
	expect(errors(row("kling-o3-image"), { ...ok, options: withoutSize })).toEqual({
		size: "Choose a size this model offers.",
	});
	expect(
		errors(row("kling-o3-image"), { ...ok, options: { ...ok.options, size: "auto" } }),
	).toEqual({
		size: "Choose a size this model offers.",
	});
	// A 4K tier stays withheld until G13.
	expect(
		errors(row("kling-o3-image"), { ...ok, options: { ...ok.options, resolution: "4K" } }),
	).toEqual({ resolution: "Choose a resolution this model offers." });
	expect(errors(row("kling-o3-image"), Object.create(ok))).toEqual({
		draft: "Choose an image model and its options again.",
	});
});

test("seed is omitted when empty and refused as a float or an unsafe integer", () => {
	const base = { ...createDerivedDraft(qwen), prompt };
	expect(errors(qwen, base)).toBeNull();
	expect(errors(qwen, { ...base, options: { ...base.options, seed: 42 } })).toBeNull();
	expect(errors(qwen, { ...base, options: { ...base.options, seed: -7 } })).toBeNull();
	for (const seed of [1.5, 2 ** 53, "42", null, Number.NaN])
		expect(errors(qwen, { ...base, options: { ...base.options, seed } })).toEqual({
			seed: "Use a whole number seed, or leave it empty.",
		});
	const validated = validateDerivedDraft(qwen, base);
	if (!validated.ok) throw new Error("Expected a valid draft.");
	expect(buildDerivedRequest(qwen, validated.draft).body.input).not.toHaveProperty("seed");
	const seeded = validateDerivedDraft(qwen, { ...base, options: { ...base.options, seed: 42 } });
	if (!seeded.ok) throw new Error("Expected a valid draft.");
	expect(buildDerivedRequest(qwen, seeded.draft).body.input).toMatchObject({ seed: 42 });
});

test("n: 1 is sent only where the row has a count field, and the D4 field always as false", () => {
	const valid = (target: QueueRow, value: DerivedDraft) => {
		const result = validateDerivedDraft(target, value);
		if (!result.ok) throw new Error(JSON.stringify(result.errors));
		return buildDerivedRequest(target, result.draft);
	};
	const flux = valid(row("flux-dev"), draft("flux-dev"));
	expect(flux).toEqual({
		method: "POST",
		url: "https://api.poyo.ai/api/generate/submit",
		body: {
			model: "flux-dev",
			input: { prompt, output_format: "png", n: 1, enable_safety_checker: false },
		},
	});
	const flash = valid(row("seedream-5.0-flash"), draft("seedream-5.0-flash"));
	expect(flash.body.input).not.toHaveProperty("n");
	expect(flash.body.input.enable_safety_checker).toBe(false);
	expect(Object.keys(flash.body.input)).toEqual([
		"prompt",
		"output_format",
		"resolution",
		"size",
		"enable_safety_checker",
	]);
});

test("a prompt outside its limit in code points is refused, at the 5,000 envelope where undocumented", () => {
	const gpt = row("gpt-4o-image");
	expect(gpt.prompt).toEqual({ min: 1, max: 1000, documented: true });
	expect(errors(gpt, draft("gpt-4o-image", { prompt: "𝄞".repeat(1000) }))).toBeNull();
	expect(errors(gpt, draft("gpt-4o-image", { prompt: "𝄞".repeat(1001) }))).toEqual({
		prompt: "Use 1–1,000 characters for this model.",
	});
	expect(errors(gpt, draft("gpt-4o-image", { prompt: "   " }))).toEqual({
		prompt: "Use 1–1,000 characters for this model.",
	});
	const flux = row("flux-dev");
	expect(errors(flux, draft("flux-dev", { prompt: "a".repeat(5000) }))).toBeNull();
	expect(errors(flux, draft("flux-dev", { prompt: "a".repeat(5001) }))).toEqual({
		prompt: "Use 1–5,000 characters for this model.",
	});
	const longer = { ...flux, prompt: { min: 3, max: 10, documented: true } };
	expect(errors(longer, { ...draft("flux-dev"), prompt: "ab" })).toEqual({
		prompt: "Use 3–10 characters for this model.",
	});
});

test("a refused combination and a custom flux-3-klein size are refused before Review", () => {
	const base = { ...createDerivedDraft(qwen), prompt };
	expect(
		errors(qwen, {
			...base,
			options: { ...base.options, background: "transparent", output_format: "jpeg" },
		}),
	).toEqual({ output_format: "This model does not offer jpeg with a transparent background." });
	expect(
		errors(qwen, {
			...base,
			options: { ...base.options, background: "transparent", output_format: "png" },
		}),
	).toBeNull();
	const klein = draft("flux-3-klein");
	expect(
		errors(row("flux-3-klein"), {
			...klein,
			options: { ...klein.options, size: "1536x1024", resolution: "2K" },
		}),
	).toEqual({ size: "Choose a size this model offers." });
});

const pinned = (model: string): RowSchemas => {
	const sha = (value: unknown) =>
		new Bun.CryptoHasher("sha256").update(canonicalJson(value)).digest("hex");
	const entry = catalog.entries.find((item) => item.model_id === model);
	if (!entry) throw new Error(`No catalog entry for ${model}.`);
	const api = (openapi.models as Record<string, { input: string }>)[model];
	return {
		catalog: { schema: entry.input_schema as Schema, sha256: sha(entry.input_schema) },
		rest: api
			? { schema: (openapi.schemas as Record<string, Schema>)[api.input], sha256: api.input }
			: null,
	};
};

test("every queue row's built body validates against both of its schemas", () => {
	const bound = schemas as unknown as {
		rows: Record<string, { catalog: string; rest: string | null }>;
		schemas: Record<string, Schema>;
	};
	for (const target of rows) {
		const result = validateDerivedDraft(target, draft(target.key.model));
		if (!result.ok) throw new Error(`${target.key.model}: ${JSON.stringify(result.errors)}`);
		const { body } = buildDerivedRequest(target, result.draft);
		const { catalog: c, rest: r } = bound.rows[`${target.key.model} text-to-image`];
		expect([
			target.key.model,
			validateBody(
				{
					catalog: { schema: bound.schemas[c], sha256: c },
					rest: r ? { schema: bound.schemas[r], sha256: r } : null,
				},
				body.input,
				reviewedRules,
			),
		]).toEqual([target.key.model, []]);
	}
	// qwen-image-2.1's own schemas refuse the fixture's refused pair as well.
	expect(
		validateBody(pinned("qwen-image-2.1"), {
			prompt,
			background: "transparent",
			output_format: "jpeg",
		}),
	).not.toEqual([]);
});

test("a catalog-only field fails against a closed REST input", () => {
	const fixed = pinned("gpt-image-2.6-fixed");
	expect(validateBody(fixed, { prompt, resolution: "1K" })).toContain(
		"API: input does not accept resolution",
	);
	expect(validateBody(fixed, { prompt })).toEqual([]);
});
