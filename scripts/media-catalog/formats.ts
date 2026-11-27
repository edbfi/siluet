// The browser's output-format projection of the derived Poyo.ai image rows: each row's exact ID
// and, where its schema has the option, the `output_format` values both sources accept and the
// effective default when it is resolved, or the reason the deriver could not offer it.
// `bun run catalog:derive` writes it beside poyo-rows.json, so the composer and Review read
// formats from row data without shipping the whole rows file. Which of these values Siluet offers
// is decided in the browser-safe formats module.
import { canonicalJson } from "../../src/lib/shared/media-catalog/canonical";
import type { FormatRow } from "../../src/lib/shared/media-catalog/formats";
import { type DerivedRow, deriveRows } from "./derive";
import { formatEvidence } from "./format-evidence";

const field = "output_format";

/** One entry per derived image row, in row order. A row without the option has no formats. */
export function formatRows(rows: DerivedRow[] = deriveRows()): FormatRow[] {
	return rows
		.filter((row) => row.media === "image")
		.map((row) => {
			const evidence = formatEvidence(row.options.find((candidate) => candidate.field === field));
			if (!evidence) return { model: row.model };
			return {
				model: row.model,
				[field]:
					"pending" in evidence
						? { pending: evidence.pending }
						: {
								values: [...evidence.values],
								...(evidence.default && { default: evidence.default }),
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
