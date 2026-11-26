import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { canonicalJson } from "../../src/lib/shared/media-catalog/canonical";
import { releasedOperations } from "../../src/lib/shared/media-catalog/registry";
import { deriveRows } from "./derive";
import { pickerPath, pickerRows, renderPicker, reviewOnlyReason } from "./picker";

const committed = readFileSync(pickerPath, "utf8");
const rows = deriveRows();
const picker = pickerRows(rows);
const reason = (model: string) => picker.find((row) => row.model === model)?.reason;

test("the picker projection reproduces byte for byte, canonical and far smaller than the rows", () => {
	expect(renderPicker()).toBe(committed);
	expect(`${canonicalJson(JSON.parse(committed))}\n`).toBe(committed);
	const rowsBytes = readFileSync(
		new URL("../../src/lib/shared/media-catalog/poyo-rows.json", import.meta.url),
	).byteLength;
	expect(Buffer.byteLength(committed)).toBeLessThan(rowsBytes / 4);
});

test("every derived row is listed once, unless a shipped Poyo.ai operation already offers its model", () => {
	const shipped = new Set<string>(
		releasedOperations.filter(({ key }) => key.provider === "poyo").map(({ key }) => key.model),
	);
	expect([...shipped].sort()).toEqual(["h3-max", "seedream-5.5", "z-image"]);
	expect(picker.map(({ model }) => model)).toEqual(
		rows.map(({ model }) => model).filter((model) => !shipped.has(model)),
	);
	for (const row of picker) {
		const derived = rows.find(({ model }) => model === row.model);
		expect(row).toEqual({
			model: row.model,
			media: derived?.media as "image" | "video",
			operations: derived?.operations as string[],
			reason: expect.any(String),
		});
		expect(row.reason.length).toBeGreaterThan(0);
		expect(row.reason.length).toBeLessThanOrEqual(80);
	}
});

test("each reason names the row's first blocker: its schema, its D4 state or its slice", () => {
	// Row-level pending reasons come first, as the deriver recorded them.
	expect(reason("kling-4.0")).toBe(
		"schema uses oneOf in allOf, items in allOf, x-server-validation",
	);
	expect(reason("ideogram-v4.6")).toBe("not in the pinned catalog: G2c re-pins");
	// Otherwise the slice that holds the row's first operation, as catalog:coverage assigns it.
	expect(reason("flux-dev")).toBe("Poyo.ai text-to-image is not verified yet (G4)");
	expect(reason("wan2.5-text-to-video")).toBe("Poyo.ai text-to-video is not verified yet (G7)");
	// Closed-schema image rows queue only after the acknowledgement lands with G6.
	expect(reason("gpt-image-2.6-fixed")).toBe(
		"closed-schema Poyo.ai images are not verified yet (G6)",
	);
	expect(reason("seedance-2.5")).toBe("Poyo.ai text-to-video is not verified yet (G7)");
	expect(reason("poyo-ai/image-translator")).toBe("open question: target-language option");
	expect(reason("kling-4.0-long-image")).toBe("open question: documented output bound");
	expect(reason("create-music-video")).toBe(
		"planned for Phase 3: music and parent-task prerequisites",
	);
});

test("a blocking D4 state reads plainly", () => {
	const row = rows.find(({ model }) => model === "flux-dev");
	if (!row) throw new Error("flux-dev has no derived row.");
	expect(reviewOnlyReason({ ...row, pending: ["D4 contradiction"] })).toBe(
		"Poyo.ai's schemas disagree on the filtering field",
	);
	expect(reviewOnlyReason({ ...row, pending: ["D4 unknown"] })).toBe(
		"the filtering field is not derived yet",
	);
	expect(reviewOnlyReason({ ...row, pending: ["D4 refused"] })).toBe(
		"Poyo.ai refuses the filtering field",
	);
});
