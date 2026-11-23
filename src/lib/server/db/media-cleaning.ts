import { sql } from "drizzle-orm";
import type { CleaningSetting } from "../../shared/media-staging/cleaning";
import type { Installation, InstallationTransaction } from "./installation";

type Row = { enabled: number; revision: number };
const unavailable = () => new Error("Cleaning setting unavailable.");
const setting = (row: Row | undefined): CleaningSetting => {
	if (!row) throw unavailable();
	return { enabled: row.enabled === 1, revision: row.revision };
};
const select = sql`SELECT enabled, revision FROM media_cleaning WHERE singleton=1`;

/** Read the setting in an open transaction, as a claim does. */
export async function readCleaningIn(tx: Pick<InstallationTransaction, "get">) {
	return setting(await tx.get<Row>(select));
}

/** The owner's cleaning setting (D10). A failed read refuses; it never picks a mode. */
export function mediaCleaning({ use }: Pick<Installation, "use">) {
	return {
		read: () => use((db) => readCleaningIn(db)),
		/**
		 * Save `enabled` if `expectedRevision` is current. An unchanged value keeps the
		 * revision; a change bumps it. A stale revision saves nothing and returns the stored value.
		 */
		set(enabled: boolean, expectedRevision: number) {
			return use((db) =>
				db.transaction(
					async (tx) => {
						const stored = setting(await tx.get<Row>(select));
						if (stored.revision !== expectedRevision) return { saved: false, ...stored };
						if (stored.enabled === enabled) return { saved: true, ...stored };
						const next = setting(
							await tx.get<Row>(sql`UPDATE media_cleaning SET enabled=${Number(enabled)},
								revision=revision+1 WHERE singleton=1 AND revision=${expectedRevision}
								RETURNING enabled, revision`),
						);
						return { saved: true, ...next };
					},
					{ behavior: "immediate" },
				),
			);
		},
	};
}
