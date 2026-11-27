import { expect, test } from "bun:test";
import {
	optionClass,
	poyoAccessNote,
	type QueueConditions,
	qualifiedClasses,
	queueBlocker,
} from "./eligibility";

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
	expect(queueBlocker({ ...eligible, classes: ["prompt", "boolean"] })).toBe(
		"Queue is unavailable: class not yet qualified: boolean.",
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
		classes: ["boolean"],
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

test("prompt, enums and output formats are qualified; a listed-set rule projects as an enum", () => {
	expect(qualifiedClasses).toEqual(["prompt", "enum", "output_format"]);
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
