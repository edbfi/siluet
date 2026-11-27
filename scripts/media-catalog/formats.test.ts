import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { canonicalJson } from "../../src/lib/shared/media-catalog/canonical";
import { deriveRows } from "./derive";
import { formatRows, formatsPath, renderFormats } from "./formats";

const committed = readFileSync(formatsPath, "utf8");
const rows = deriveRows();

test("the formats projection reproduces byte for byte, canonical and small", () => {
	expect(renderFormats()).toBe(committed);
	expect(`${canonicalJson(JSON.parse(committed))}\n`).toBe(committed);
	expect(Buffer.byteLength(committed)).toBeLessThan(8 * 1024);
});

test("every derived image row is listed once with its schema's output formats and resolved default", () => {
	const images = rows.filter((row) => row.media === "image");
	const projected = formatRows(rows);
	expect(projected.map(({ model }) => model)).toEqual(images.map(({ model }) => model));
	for (const row of images) {
		const option = row.options.find(({ field }) => field === "output_format");
		const entry = projected.find(({ model }) => model === row.model);
		if (!option) {
			expect(entry).toEqual({ model: row.model });
			continue;
		}
		expect(entry?.output_format).toEqual({
			values: option.domain.values as string[],
			...(option.default.state === "resolved" && { default: option.default.value as string }),
		});
	}
	// 35 rows document the option; Nano Banana 2, 2 New and their edits drop it under the
	// reviewed "Pro only" and "Official only" exclusions.
	expect(projected.filter((entry) => entry.output_format)).toHaveLength(31);
	for (const model of [
		"nano-banana-2",
		"nano-banana-2-edit",
		"nano-banana-2-new",
		"nano-banana-2-new-edit",
	])
		expect(projected.find((entry) => entry.model === model)).toEqual({ model });
});

test("an output format with a gap is recorded as pending with its reason, never thrown", () => {
	const [row] = rows.filter((candidate) => candidate.model === "seedream-5.5");
	const gapped = {
		...row,
		options: row.options.map((option) =>
			option.field === "output_format"
				? { ...option, gap: { state: "pending" as const, reason: "fixture" } }
				: option,
		),
	};
	expect(formatRows([gapped])).toEqual([
		{ model: "seedream-5.5", output_format: { pending: "fixture" } },
	]);
});
