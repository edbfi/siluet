// What a derived Poyo.ai text-to-image Review states and binds (catalog engine spec, "Families
// and admission", "Gallery size limits" and condition 5). Review shows each part, and the
// Review terms bind them, so a change to any of them makes an unclaimed Review stale.
import { poyoAccessNote } from "../media-catalog/eligibility";
import { d4Wording } from "../media-catalog/filtering";
import { queueRevision } from "../media-catalog/image-queue";
import type { QueueRow } from "../media-catalog/queue-row";

/** Gallery's image limit today: 16,000,000 pixels (G13 raises it). */
export const galleryMegapixels = 16;

/** The family's verified representative, named on every derived Review. */
export const samePathSentence = `Same request path as verified Seedream 5.5 on Poyo.ai. Options from Poyo.ai's schema dated 2026-11-26 (\`${queueRevision.slice(0, 7)}\`). This model was not tested individually.`;

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
		samePath: samePathSentence,
		d4: d4Wording("poyo", row.d4) ?? [],
		gallery: galleryStatement,
		access: poyoAccessNote,
	};
}
