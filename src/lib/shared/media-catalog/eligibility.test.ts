import { expect, test } from "bun:test";
import { optionClass, poyoAccessNote, qualifiedClasses } from "./eligibility";
import projection from "./poyo-queue.json";

test("booleans and integers join once qwen-image-2.1 qualifies them; a listed-set rule is an enum", () => {
	expect(qualifiedClasses).toEqual(["prompt", "enum", "output_format", "boolean", "integer"]);
	// Free text and numbers stay unqualified on Poyo.ai images (questions 6 and 3).
	expect(qualifiedClasses).not.toContain("free text");
	expect(qualifiedClasses).not.toContain("number");
	expect(optionClass({ field: "prompt", kind: "free-text", domain: {} })).toBe("prompt");
	expect(optionClass({ field: "negative_prompt", kind: "free-text", domain: {} })).toBe(
		"free text",
	);
	expect(optionClass({ field: "output_format", kind: "enum", domain: { values: ["png"] } })).toBe(
		"output_format",
	);
	expect(optionClass({ field: "size", kind: "rule", domain: { values: ["1:1"] } })).toBe("enum");
	expect(optionClass({ field: "size", kind: "rule", domain: {} })).toBe("rule");
	expect(optionClass({ field: "seed", kind: "integer", domain: {} })).toBe("integer");
	expect(optionClass({ field: "web", kind: "boolean", domain: {} })).toBe("boolean");
});

test("the access note says what Siluet checked and what Poyo.ai does not publish", () => {
	expect(poyoAccessNote).toBe(
		"Poyo.ai does not publish per-key model access. Siluet has checked only that this key works.",
	);
});

test("nano-banana-pro and wan-2.7-image and -pro queue once booleans and integers qualify", () => {
	const models = projection.rows.map((row) => row.key.model);
	for (const model of ["nano-banana-pro", "wan-2.7-image", "wan-2.7-image-pro", "qwen-image-2.1"])
		expect(models).toContain(model);
	const pro = projection.rows.find((row) => row.key.model === "nano-banana-pro");
	expect(pro?.fields.find((field) => field.wire === "enable_web_search")).toEqual({
		wire: "enable_web_search",
		kind: "boolean",
		preselect: false,
	});
	const wan = projection.rows.find((row) => row.key.model === "wan-2.7-image");
	expect(wan?.fields.find((field) => field.wire === "seed")).toEqual({
		wire: "seed",
		kind: "integer",
		optional: true,
	});
});
