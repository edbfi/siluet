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
		expect(entry?.output_format?.values).toEqual(option.domain.values as string[]);
		expect(entry?.output_format?.default).toBe(
			option.default.state === "resolved" ? (option.default.value as string) : undefined,
		);
	}
	expect(projected.filter((entry) => entry.output_format)).toHaveLength(35);
});

test("an output format with a gap or no enum domain is not projected as offerable", () => {
	const [row] = rows.filter((candidate) => candidate.model === "seedream-5.5");
	const gapped = {
		...row,
		options: row.options.map((option) =>
			option.field === "output_format"
				? { ...option, gap: { state: "pending" as const, reason: "fixture" } }
				: option,
		),
	};
	expect(() => formatRows([gapped])).toThrow(
		"seedream-5.5 output_format has no typed enum domain.",
	);
});
