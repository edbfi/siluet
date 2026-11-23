import { sql } from "drizzle-orm";
import {
	currentCredential,
	type ImageJob,
	noGalleryItemSql,
	retryableSql,
	type SaveHold,
} from "./image-job-store";
import type { Installation } from "./installation";

/** Failed downloads before a job shows Download failed. */
export const saveTryLimit = 3;

/** An outcome the claimed attempt recorded, or `fenced` when Remove or restart took it back. */
export type SaveOutcome = "done" | "fenced";

const claimable = (
	now: number,
) => sql`image_job.state='completed' AND image_job.save_due IS NOT NULL
	AND image_job.save_due<=${now} AND image_job.save_hold IS NULL AND image_job.save_attempt IS NULL
	AND ${noGalleryItemSql}`;

/** The durable intent, hold and attempt fence behind automatic Save (D9). */
export function saveIntentStore({ use }: Installation) {
	/**
	 * Every outcome applies only to the attempt that still holds the job, under its current key
	 * and with no hold, as publication does. A replaced key gets the claim back unchanged.
	 */
	async function settle(id: string, token: string, changes: ReturnType<typeof sql>) {
		const row = await use(async (db) => {
			const done = await db.get(sql`UPDATE image_job SET save_attempt=NULL, ${changes}
				WHERE id=${id} AND save_attempt=${token} AND save_hold IS NULL AND ${currentCredential}
				RETURNING id`);
			if (!done)
				await db.run(
					sql`UPDATE image_job SET save_attempt=NULL WHERE id=${id} AND save_attempt=${token}`,
				);
			return done;
		});
		return (row ? "done" : "fenced") satisfies SaveOutcome;
	}
	return {
		/** Due, unclaimed intents, oldest first. */
		pendingSaves(now: number) {
			return use((db) =>
				db.all<ImageJob>(
					sql`SELECT * FROM image_job WHERE ${claimable(now)} ORDER BY save_due, created_at, id`,
				),
			);
		},
		/** The earliest later time an unclaimed intent becomes due. */
		async nextDue(now: number) {
			const row = await use((db) =>
				db.get<{ due: number | null }>(sql`SELECT MIN(save_due) AS due FROM image_job
					WHERE state='completed' AND save_due>${now} AND save_hold IS NULL AND save_attempt IS NULL
					AND ${noGalleryItemSql}`),
			);
			return row?.due ?? null;
		},
		claim(id: string, token: string, now: number) {
			return use((db) =>
				db.get<ImageJob>(sql`UPDATE image_job SET save_attempt=${token}
					WHERE id=${id} AND ${claimable(now)} RETURNING *`),
			);
		},
		/** Try again at `until` with `tries` failures counted. */
		defer(id: string, token: string, until: number, tries: number) {
			return settle(id, token, sql`save_due=MAX(save_due,${until}), save_tries=${tries}`);
		},
		hold(id: string, token: string, reason: SaveHold, tries?: number) {
			return settle(
				id,
				token,
				sql`save_due=NULL, save_hold=${reason}, save_tries=COALESCE(${tries ?? null},save_tries)`,
			);
		},
		/**
		 * The provider's link has expired: nothing is left to download. Expiry is a row timestamp
		 * that needs no key, so a replaced or removed key cannot keep the intent pending.
		 */
		async expire(id: string, token: string, now: number) {
			const row = await use(async (db) => {
				const done = await db.get(sql`UPDATE image_job SET save_attempt=NULL, save_due=NULL
					WHERE id=${id} AND save_attempt=${token} AND save_hold IS NULL
					AND expires_at IS NOT NULL AND expires_at<=${now} RETURNING id`);
				if (!done)
					await db.run(
						sql`UPDATE image_job SET save_attempt=NULL WHERE id=${id} AND save_attempt=${token}`,
					);
				return done;
			});
			return (row ? "done" : "fenced") satisfies SaveOutcome;
		},
		/** Shutdown, a read pause or a replaced key: give the attempt back without counting a try. */
		release(id: string, token: string) {
			return settle(id, token, sql`save_due=save_due`);
		},
		/** Startup: attempts from an earlier process ended with it. */
		clearAbandoned() {
			return use((db) =>
				db.run(sql`UPDATE image_job SET save_attempt=NULL WHERE save_attempt IS NOT NULL`),
			);
		},
		/**
		 * Retry download or Download again: arm a failed, removed or missing result whose
		 * link is unexpired, whose key is current and whose reads are not paused.
		 */
		retry(id: string, now: number) {
			return use((db) =>
				db.transaction(
					async (tx) => {
						const eligible = sql`id=${id} AND ${retryableSql(now)} AND ${currentCredential}
							AND save_attempt IS NULL`;
						const missing = await tx.get(sql`SELECT 1 FROM image_job WHERE ${eligible}
							AND save_hold IS NULL AND EXISTS (
								SELECT 1 FROM gallery_image WHERE job_id=${id} AND state='unavailable'
							)`);
						if (missing)
							await tx.run(
								sql`DELETE FROM gallery_image WHERE job_id=${id} AND state='unavailable'`,
							);
						const armed = await tx.get(sql`UPDATE image_job SET save_hold=NULL, save_tries=0,
							save_due=MAX(${now},COALESCE(next_read_at,0))
							WHERE ${eligible} AND ${noGalleryItemSql}
								AND (save_hold IN ('failed','removed') OR ${!!missing})
							RETURNING id`);
						return !!armed;
					},
					{ behavior: "immediate" },
				),
			);
		},
	};
}
