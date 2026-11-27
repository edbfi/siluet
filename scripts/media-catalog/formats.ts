// The browser's output-format projection of the derived Poyo.ai image rows: each row's exact ID
// and, where its schema has the option, the `output_format` values both sources accept and the
// effective default when it is resolved. `bun run catalog:derive` writes it beside poyo-rows.json,
// so the composer and Review read formats from row data without shipping the whole rows file.
// Which of these values Siluet offers is decided in the browser-safe formats module.
import { canonicalJson } from "../../src/lib/shared/media-catalog/canonical";
import type { FormatRow } from "../../src/lib/shared/media-catalog/formats";
import { type DerivedRow, deriveRows } from "./derive";

const field = "output_format";

/** One entry per derived image row, in row order. A row without the option has no formats. */
export function formatRows(rows: DerivedRow[] = deriveRows()): FormatRow[] {
	return rows
		.filter((row) => row.media === "image")
		.map((row) => {
			const option = row.options.find((candidate) => candidate.field === field);
			if (!option) return { model: row.model };
			const { values } = option.domain;
			// Fail closed: a format option the deriver could not type needs a reviewed decision.
			if (
				option.kind !== "enum" ||
				option.gap ||
				!values?.every((value) => typeof value === "string")
			)
				throw new Error(`${row.model} ${field} has no typed enum domain.`);
			const resolved = option.default.state === "resolved" ? option.default.value : undefined;
			if (resolved !== undefined && typeof resolved !== "string")
				throw new Error(`${row.model} ${field} has a non-string default.`);
			return {
				model: row.model,
				[field]: {
					values: values as string[],
					...(resolved !== undefined && { default: resolved }),
				},
			};
		});
}

/** Canonical compact JSON, with the one final newline the repository's hooks expect. */
export function renderFormats(rows?: DerivedRow[]) {
	return `${canonicalJson({ rows: formatRows(rows) })}\n`;
}

export const formatsPath = new URL(
	"../../src/lib/shared/media-catalog/poyo-formats.json",
	import.meta.url,
);
