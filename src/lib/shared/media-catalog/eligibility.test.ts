import { expect, test } from "bun:test";
import {
	optionClass,
	poyoAccessNote,
	type QueueConditions,
	qualifiedClasses,
	queueBlocker,
} from "./eligibility";
import projection from "./poyo-queue.json";

const eligible: QueueConditions = {
	contract: null,
	classes: ["prompt", "enum", "output_format"],
	d4: { d4: "open-absent" },
	price: "consented",
	save: null,
	access: true,
};

test("a row that meets every condition queues", () => {
	expect(queueBlocker(eligible)).toBeNull();
	expect(queueBlocker({ ...eligible, price: "known", d4: { d4: "declared" } })).toBeNull();
});

test("each condition failing alone names itself", () => {
	expect(queueBlocker({ ...eligible, contract: "the preselected request does not validate" })).toBe(
		"Queue is unavailable: the preselected request does not validate.",
	);
	expect(queueBlocker({ ...eligible, classes: ["prompt", "number"] })).toBe(
		"Queue is unavailable: class not yet qualified: number.",
	);
	expect(queueBlocker({ ...eligible, d4: { d4: "closed-absent", closedBy: "api" } })).toBe(
		"Queue is unavailable until closed-schema Poyo.ai images take their acknowledgement (G6).",
	);
	expect(queueBlocker({ ...eligible, d4: { d4: "contradiction" } })).toBe(
		"Queue is unavailable because the filtering flag conflicts with the provider contract.",
	);
	expect(queueBlocker({ ...eligible, price: "unknown" })).toBe(
		"Accept the unknown price to queue this request.",
	);
	expect(queueBlocker({ ...eligible, save: "Gallery saves none of its output formats" })).toBe(
		"Queue is unavailable: Gallery saves none of its output formats.",
	);
	expect(queueBlocker({ ...eligible, access: false })).toBe(
		"Connect a Poyo.ai key whose balance check passed in Settings.",
	);
});

test("conditions are checked in the spec's order: contract, D4, price, Save, access", () => {
	const all: QueueConditions = {
		contract: "no valid request",
		classes: ["number"],
		d4: { d4: "unknown" },
		price: "unknown",
		save: "no format",
		access: false,
	};
	expect(queueBlocker(all)).toBe("Queue is unavailable: no valid request.");
	expect(queueBlocker({ ...all, contract: null })).toContain("class not yet qualified");
	expect(queueBlocker({ ...all, contract: null, classes: [] })).toContain("filtering flag");
	expect(queueBlocker({ ...all, contract: null, classes: [], d4: { d4: "declared" } })).toBe(
		"Accept the unknown price to queue this request.",
	);
});

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
