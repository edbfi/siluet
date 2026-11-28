// What a derived Poyo.ai text-to-image Review states and binds (catalog engine spec, "Families
// and admission", "Gallery size limits" and condition 5). Review shows each part, and the
// Review terms bind them, so a change to any of them makes an unclaimed Review stale.

import { galleryMegapixels } from "../gallery/limits";
import { derivedVerifiedOperations } from "../media-catalog/derived-verified";
import { poyoAccessNote } from "../media-catalog/eligibility";
import { d4Wording } from "../media-catalog/filtering";
import { queueRevision, queueRevisionDate } from "../media-catalog/image-queue";
import type { QueueRow } from "../media-catalog/queue-row";

const schemaSentence = `Options from Poyo.ai's schema dated ${queueRevisionDate} (${queueRevision.slice(0, 7)}).`;

/** The family's verified representative, named on every derived Review of an untested row. */
export const samePathSentence = `Same request path as verified Seedream 5.5 on Poyo.ai. ${schemaSentence} This model was not tested individually.`;

/** A verified representative's own sentence: the classes it was verified for. */
function verifiedSentence(row: QueueRow) {
	const verified = derivedVerifiedOperations.find(
		({ key }) => key.model === row.key.model && key.operation === row.key.operation,
	);
	if (!verified) return null;
	const classes = verified.classes.join(" and ");
	return `${row.key.model} is verified on Poyo.ai for ${classes} options. ${schemaSentence}`;
}

/** No derived request bounds its output, so Review always states Gallery's limit. */
export const galleryStatement = `Gallery saves images up to ${galleryMegapixels} megapixels. A completed billable image over that stays with the provider.`;

export type DerivedWording = {
	readonly samePath: string;
	/** The D4 disclosure an open-absent row binds; none for a declared row. */
	readonly d4: readonly string[];
	readonly gallery: string;
	readonly access: string;
};

/** Everything a derived Review shows and binds besides the request and its price. */
export function derivedWording(row: QueueRow): DerivedWording {
	return {
		samePath: verifiedSentence(row) ?? samePathSentence,
		d4: d4Wording("poyo", row.d4) ?? [],
		gallery: galleryStatement,
		access: poyoAccessNote,
	};
}

/** Review's note for a refusal Poyo.ai confirmed for this key; it never blocks Queue. */
export const refusalNote = (refusedAt: number) =>
	`Poyo.ai refused this model for this key on ${new Date(refusedAt).toISOString().slice(0, 10)}.`;

/** The values each field cannot take with the others chosen, under the row's combinations. */
export function refusedValues(row: QueueRow, options: Readonly<Record<string, unknown>>) {
	const refused: Record<string, unknown[]> = {};
	for (const { when, refuses } of row.combinations) {
		if (!Object.entries(when).every(([wire, value]) => options[wire] === value)) continue;
		for (const [wire, values] of Object.entries(refuses))
			refused[wire] = [...new Set([...(refused[wire] ?? []), ...values])];
	}
	return refused;
}
