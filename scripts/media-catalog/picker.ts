// The browser's picker projection of the derived Poyo.ai rows: each row's exact ID, media,
// operations and the one plain reason it is Review-only. `bun run catalog:derive` writes it
// beside poyo-rows.json, so the client never ships the whole rows file.
import { canonicalJson } from "../../src/lib/shared/media-catalog/canonical";
import type { ReviewOnlyRow } from "../../src/lib/shared/media-catalog/picker";
import { releasedOperations } from "../../src/lib/shared/media-catalog/registry";
import { assignment } from "./coverage";
import { type DerivedRow, deriveRows } from "./derive";

// What each engine slice admits, from the spec's slice table.
const slices: Record<string, string> = {
	G4: "Poyo.ai text-to-image is",
	G5: "Poyo.ai image edits are",
	G6: "closed-schema Poyo.ai images are",
	G7: "Poyo.ai text-to-video is",
	G8: "Poyo.ai frames are",
	G8b: "Poyo.ai image references are",
};

const d4Reasons: Record<string, string> = {
	"D4 contradiction": "Poyo.ai's schemas disagree on the filtering field",
	"D4 unknown": "the filtering field is not derived yet",
	"D4 refused": "Poyo.ai refuses the filtering field",
};

/** The first reason a derived row cannot queue yet, in plain words from its own data. */
export function reviewOnlyReason(row: DerivedRow) {
	const [pending] = row.pending;
	if (pending) return d4Reasons[pending] ?? pending;
	const [operation] = row.operations;
	const label = assignment({ provider: "poyo", model: row.model, route: row.route, operation });
	if (label.startsWith("P3 · ")) return `planned for Phase 3: ${label.slice(5)}`;
	if (label.startsWith("Q · ")) return `open question: ${label.slice(4)}`;
	const question = label.split(" · Q: ")[1];
	if (question) return `open question: ${question}`;
	// Closed-schema image rows queue only after the acknowledgement, which lands with G6.
	const slice =
		row.d4.d4 === "closed-absent" && row.media === "image" && /^G[45]$/.test(label) ? "G6" : label;
	if (!Object.hasOwn(slices, slice))
		throw new Error(`No picker reason for ${row.model} (${label}).`);
	return `${slices[slice]} not verified yet (${slice})`;
}

/** Every derived row the picker lists. A model with a shipped Poyo.ai operation keeps its own entry. */
export function pickerRows(rows = deriveRows()): ReviewOnlyRow[] {
	const shipped = new Set<string>(
		releasedOperations.filter(({ key }) => key.provider === "poyo").map(({ key }) => key.model),
	);
	return rows
		.filter(({ model }) => !shipped.has(model))
		.map((row) => ({
			model: row.model,
			media: row.media as ReviewOnlyRow["media"],
			operations: row.operations,
			reason: reviewOnlyReason(row),
		}));
}

/** Canonical compact JSON, with the one final newline the repository's hooks expect. */
export function renderPicker(rows?: DerivedRow[]) {
	return `${canonicalJson({ rows: pickerRows(rows) })}\n`;
}

export const pickerPath = new URL(
	"../../src/lib/shared/media-catalog/poyo-picker.json",
	import.meta.url,
);
