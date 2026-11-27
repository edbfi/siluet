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
			...(row.queue && { queue: ["text-to-image"] }),
			reason: expect.any(String),
		});
		expect(row.reason.length).toBeGreaterThan(0);
		expect(row.reason.length).toBeLessThanOrEqual(80);
	}
});

test("each reason names the row's first blocker: its schema, its D4 state or its slice", () => {
	// A row-level pending kind comes first, in one plain sentence; poyo-rows.json keeps its detail.
	expect(reason("kling-4.0")).toBe("Poyo.ai's input schema uses forms Siluet does not read yet");
	expect(reason("ideogram-v4.6")).toBe("closed-schema Poyo.ai images are not verified yet (G6)");
	expect(reason("ltx-2.5-fast")).toBe("Poyo.ai's input schema uses forms Siluet does not read yet");
	expect(reason("bria-rmbg-3.0")).toBe("closed-schema Poyo.ai images are not verified yet (G6)");
	expect(reason("recraft-v4.1-vector")).toBe("planned for Phase 3: GIF and SVG output");
	expect(reason("flux-3-max/keyframes-to-video")).toBe(
		"a required input takes a form Siluet does not read yet",
	);
	// A text-to-image row with no documented count and no evidence of one output.
	expect(reason("flux-2-pro")).toBe("Poyo.ai does not document that it returns one image");
	expect(reason("qwen-image-3")).toBe("Poyo.ai does not document that it returns one image");
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

test("every pending kind reads as one plain sentence, and an unknown kind is refused", () => {
	const row = rows.find(({ model }) => model === "flux-dev");
	if (!row) throw new Error("flux-dev has no derived row.");
	const plain = (pending: string) => reviewOnlyReason({ ...row, pending: [pending] });
	expect(plain("service chat/sync")).toBe("Poyo.ai runs it as a service Siluet does not call yet");
	expect(plain("not in the pinned catalog")).toBe(
		"Siluet's copy of Poyo.ai's catalog does not list it",
	);
	expect(plain("no valid minimal request: /input/prompt must be string")).toBe(
		"Siluet cannot build a valid request from Poyo.ai's schemas yet",
	);
	expect(() => plain("schema drifted")).toThrow("No plain reason for flux-dev (schema drifted).");
	for (const { reason } of picker)
		expect(reason).not.toMatch(/allOf|oneOf|x-server|pattern|nested|pinned|re-pins|D4|service /);
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

test("every reason a Queue row is refused reads plainly, and an unknown one is refused", () => {
	const row = rows.find(({ model }) => model === "flux-dev");
	if (!row) throw new Error("flux-dev has no derived row.");
	const queued = (reason: string) =>
		reviewOnlyReason(row, { model: "flux-dev", operation: "text-to-image", reason });
	expect(queued("class not yet qualified: number")).toBe(
		"its number options are not qualified yet (G4)",
	);
	expect(queued("Gallery saves none of its output formats")).toBe(
		"Gallery cannot save the image types this model offers",
	);
	expect(queued("output format is not a typed enum")).toBe(
		"Siluet cannot read this model's output format option yet",
	);
	expect(queued("no evidence of one output")).toBe(
		"Poyo.ai does not document that it returns one image",
	);
	expect(queued("no prompt field")).toBe("Poyo.ai's schema has no prompt field for it");
	expect(queued("it offers no size value Siluet can send")).toBe(
		"Siluet cannot send any value of one of its options yet",
	);
	expect(queued("the preselected request does not validate: /input/size must be string")).toBe(
		"Siluet cannot build a valid request from Poyo.ai's schemas yet",
	);
	expect(() => queued("schema drifted")).toThrow("No plain reason for flux-dev (schema drifted).");
});
