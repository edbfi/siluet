// The browser's picker projection of the derived Poyo.ai rows: each row's exact ID, media,
// operations and the one plain reason it is Review-only. `bun run catalog:derive` writes it
// beside poyo-rows.json, so the client never ships the whole rows file.
import { canonicalJson } from "../../src/lib/shared/media-catalog/canonical";
import type { ReviewOnlyRow } from "../../src/lib/shared/media-catalog/picker";
import { releasedOperations } from "../../src/lib/shared/media-catalog/registry";
import { assignment } from "./coverage";
import { type DerivedRow, deriveRows } from "./derive";
import { type PendingQueueRow, queueProjection } from "./queue";

// What each engine slice admits, from the spec's slice table.
const slices: Record<string, string> = {
	G4: "Poyo.ai text-to-image is",
	G5: "Poyo.ai image edits are",
	G6: "closed-schema Poyo.ai images are",
	G7: "Poyo.ai text-to-video is",
	G8: "Poyo.ai frames are",
	G8b: "Poyo.ai image references are",
};

// One plain sentence for each kind of pending reason the deriver or the Queue projection records.
// poyo-rows.json keeps the technical detail.
const pendingReasons: [kind: RegExp, reason: string][] = [
	[/^not in the pinned catalog$/, "Siluet's copy of Poyo.ai's catalog does not list it"],
	[/^service /, "Poyo.ai runs it as a service Siluet does not call yet"],
	[/^schema uses /, "Poyo.ai's input schema uses forms Siluet does not read yet"],
	[/^required input uses /, "a required input takes a form Siluet does not read yet"],
	[/^D4 contradiction$/, "Poyo.ai's schemas disagree on the filtering field"],
	[/^D4 unknown$/, "the filtering field is not derived yet"],
	[/^D4 refused$/, "Poyo.ai refuses the filtering field"],
	[/^no valid minimal request\b/, "Siluet cannot build a valid request from Poyo.ai's schemas yet"],
	[/^no evidence of one output\b/, "Poyo.ai does not document that it returns one image"],
	[
		/^Gallery saves none of its output formats$/,
		"Gallery cannot save the image types this model offers",
	],
	[
		/^output format is not a typed enum$/,
		"Siluet cannot read this model's output format option yet",
	],
	[/^no prompt field$/, "Poyo.ai's schema has no prompt field for it"],
	[
		/^it offers no \S+ value Siluet can send$/,
		"Siluet cannot send any value of one of its options yet",
	],
	[
		/^the preselected request does not validate\b/,
		"Siluet cannot build a valid request from Poyo.ai's schemas yet",
	],
];

/** The first reason a derived row cannot queue yet, in plain words from its own data. */
export function reviewOnlyReason(row: DerivedRow, queue?: PendingQueueRow) {
	const unqualified = queue?.reason.match(/^class not yet qualified: (.+)$/)?.[1];
	if (unqualified) return `its ${unqualified} options are not qualified yet (G4)`;
	// A Queue refusal starts with the row's own first pending reason, when it has one.
	const pending = queue?.reason ?? row.pending[0];
	if (pending) {
		const plain = pendingReasons.find(([kind]) => kind.test(pending));
		if (!plain) throw new Error(`No plain reason for ${row.model} (${pending}).`);
		return plain[1];
	}
	const [operation] = row.operations;
	const label = assignment(
		{ provider: "poyo", model: row.model, route: row.route, operation },
		row.d4.d4,
	);
	if (label.startsWith("P3 · ")) return `planned for Phase 3: ${label.slice(5)}`;
	if (label.startsWith("Q · ")) return `open question: ${label.slice(4)}`;
	const question = label.split(" · Q: ")[1];
	if (question) return `open question: ${question}`;
	if (!Object.hasOwn(slices, label))
		throw new Error(`No picker reason for ${row.model} (${label}).`);
	return `${slices[label]} not verified yet (${label})`;
}

/**
 * Every derived row the picker lists, with its Queue-eligible operations apart from the reason
 * the rest are Review-only. A model with a shipped Poyo.ai operation keeps its own entry.
 */
export function pickerRows(rows = deriveRows()): ReviewOnlyRow[] {
	const shipped = new Set<string>(
		releasedOperations.filter(({ key }) => key.provider === "poyo").map(({ key }) => key.model),
	);
	const { rows: eligible, pending } = queueProjection(rows);
	return rows
		.filter(({ model }) => !shipped.has(model))
		.map((row) => {
			const queue = eligible
				.filter(({ key }) => key.model === row.model)
				.map(({ key }) => key.operation);
			return {
				model: row.model,
				media: row.media as ReviewOnlyRow["media"],
				operations: row.operations,
				...(queue.length && { queue }),
				reason: reviewOnlyReason(
					row,
					pending.find(({ model }) => model === row.model),
				),
			};
		});
}

/** Canonical compact JSON, with the one final newline the repository's hooks expect. */
export function renderPicker(rows?: DerivedRow[]) {
	return `${canonicalJson({ rows: pickerRows(rows) })}\n`;
}

export const pickerPath = new URL(
	"../../src/lib/shared/media-catalog/poyo-picker.json",
	import.meta.url,
);
