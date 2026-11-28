import { type FormatRow, type OutputFormats, offeredFormats } from "./formats";
import projection from "./poyo-formats.json";

const rows = new Map((projection.rows as FormatRow[]).map((row) => [row.model, row]));

/** The offered formats of a derived Poyo.ai image row, read from the formats projection. */
export function poyoOutputFormats(model: string): OutputFormats {
	const row = rows.get(model);
	if (!row) throw new Error(`${model} is not a derived Poyo.ai image row.`);
	return offeredFormats(row.output_format);
}
