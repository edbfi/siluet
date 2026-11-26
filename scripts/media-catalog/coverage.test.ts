import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import ledger from "../../docs/media-catalog.v1.json";
import {
	assignment,
	type CoverageItem,
	coverage,
	coverageStates,
	expandKeys,
	inventoryPath,
	offerGap,
	renderInventory,
	tally,
} from "./coverage";
import { deriveRows } from "./derive";
import { verifiedOptions } from "./verified";

const rows = deriveRows();
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
	expect(keys).toHaveLength(647);
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
	const key = { provider: "poyo", model: "m", route: "POST /x", operation: "o" } as const;
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
	).toEqual([["z-image", "reference-image-edit", "size"]]);
	// A count whose only documented value is the pinned 1 adds no obligation, and a shared
	// count above 1 is the Phase 3 multi-output obligation, never `n: 1` itself.
	for (const item of options.filter((option) => option.option === "n"))
		expect(item.values).toMatch(/^\d+–\d+$/);
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
