import { sql } from "drizzle-orm";
import type { Rejection } from "../providers/image-job";
import type { ImageJob } from "./image-job-store";
import type { Installation, InstallationTransaction } from "./installation";

export type FilePhase =
	| "claimed"
	| "uploading"
	| "uploaded"
	| "editing"
	| "unsent"
	| "upload-unknown"
	| "stored"
	| "upload-rejected"
	| "edit-unknown"
	| "edit-recorded";
/** One file slot's upload: unsent, in flight, or how its receipt ended. */
export type SlotOutcome = "unsent" | "uploading" | "stored" | "unusable" | "unknown" | "rejected";
/** Why a file job stopped before its edit, when no slot outcome says it. */
export type FileStop =
	| "stage-changed"
	| "duplicate"
	| "expired-link"
	| "cooldown"
	| "interrupted"
	| "destination"
	| "unusable";
export const maxFileReferences = 10;

type Tx = Pick<InstallationTransaction, "get" | "run" | "all">;
const live = (id: string, owner: string) =>
	sql`id=${id} AND file_owner=${owner} AND state='submitting'`;

/** In the claim transaction: one unsent row per file slot, and the reference count. */
export async function claimFileSlots(
	tx: Tx,
	id: string,
	positions: readonly number[],
	references: number,
) {
	if (
		!positions.length ||
		references > maxFileReferences ||
		positions.some(
			(p, i) => !Number.isInteger(p) || p < 1 || p > references || p <= positions[i - 1],
		)
	)
		throw new Error("Invalid file slots.");
	for (const position of positions)
		await tx.run(sql`INSERT INTO file_slot VALUES(${id},${position},'unsent')`);
	await tx.run(sql`UPDATE image_job SET file_references=${references} WHERE id=${id}`);
}

/**
 * At an upload's send boundary: the job moves to `uploading` and this slot from `unsent`
 * to `uploading`, in the caller's transaction. Every earlier file slot must be stored.
 */
export async function startFileUpload(
	tx: Tx,
	id: string,
	owner: string,
	position: number,
	time: number,
) {
	const started = await tx.get(sql`UPDATE image_job SET file_phase='uploading',updated_at=${time}
		WHERE ${live(id, owner)} AND file_phase IN ('claimed','uploaded')
		AND EXISTS(SELECT 1 FROM file_slot WHERE job_id=${id} AND position=${position} AND outcome='unsent')
		AND NOT EXISTS(SELECT 1 FROM file_slot WHERE job_id=${id} AND position<${position} AND outcome<>'stored')
		RETURNING id`);
	if (!started) return false;
	await tx.run(
		sql`UPDATE file_slot SET outcome='uploading' WHERE job_id=${id} AND position=${position}`,
	);
	return true;
}

/** Undo a marker whose POST was positively never handed to transport. */
export async function undoFileUpload(
	tx: Tx,
	id: string,
	owner: string,
	position: number,
	time: number,
) {
	const restored = await tx.get(sql`UPDATE image_job SET file_phase=CASE WHEN EXISTS(
			SELECT 1 FROM file_slot WHERE job_id=${id} AND outcome='stored') THEN 'uploaded' ELSE 'claimed' END
		WHERE ${live(id, owner)} AND file_phase='uploading' AND updated_at=${time} RETURNING id`);
	if (!restored) throw new Error("File dispatch marker changed.");
	await tx.run(
		sql`UPDATE file_slot SET outcome='unsent' WHERE job_id=${id} AND position=${position} AND outcome='uploading'`,
	);
}

/** At the edit's send boundary: every file slot holds a usable stored receipt. */
export async function startFileEdit(tx: Tx, id: string, owner: string, time: number) {
	return !!(await tx.get(sql`UPDATE image_job SET file_phase='editing',updated_at=${time}
		WHERE ${live(id, owner)} AND file_phase='uploaded'
		AND EXISTS(SELECT 1 FROM file_slot WHERE job_id=${id})
		AND NOT EXISTS(SELECT 1 FROM file_slot WHERE job_id=${id} AND outcome<>'stored') RETURNING id`));
}

export async function undoFileEdit(tx: Tx, id: string, owner: string, time: number) {
	const restored = await tx.get(sql`UPDATE image_job SET file_phase='uploaded'
		WHERE ${live(id, owner)} AND file_phase='editing' AND updated_at=${time} RETURNING id`);
	if (!restored) throw new Error("File dispatch marker changed.");
}

export type StopFileJob = {
	/** How the slot in flight ended, when the job stops during its upload. */
	outcome?: Exclude<SlotOutcome, "unsent" | "uploading">;
	stop?: FileStop;
	slot?: number | null;
	other?: number | null;
	rejection?: Rejection | null;
	/** A provider cooldown's end. */
	until?: number | null;
};

export function fileAttemptStore({ use }: Installation, owner: string) {
	return {
		/** A usable receipt: the slot is stored and the job may start its next send. */
		stored(id: string, position: number, now: number) {
			return use((db) =>
				db.transaction(
					async (tx) => {
						const job =
							await tx.get(sql`UPDATE image_job SET file_phase='uploaded',updated_at=${now}
							WHERE ${live(id, owner)} AND file_phase='uploading' RETURNING id`);
						if (!job) return false;
						const slot = await tx.get(sql`UPDATE file_slot SET outcome='stored'
							WHERE job_id=${id} AND position=${position} AND outcome='uploading' RETURNING position`);
						if (!slot) throw new Error("File slot changed.");
						return true;
					},
					{ behavior: "immediate" },
				),
			);
		},
		/**
		 * End the job before its edit. With no POST the wallet closes uncompared; an
		 * unknown upload keeps it open with no after-read; otherwise the dispatcher may
		 * take one bounded after-read.
		 */
		stop(id: string, end: StopFileJob, now: number) {
			return use((db) =>
				db.transaction(
					async (tx) => {
						const job = await tx.get<{ file_phase: FilePhase }>(sql`SELECT file_phase FROM image_job
							WHERE ${live(id, owner)} AND file_phase IN ('claimed','uploading','uploaded')`);
						if (!job) return undefined;
						if (job.file_phase === "uploading") {
							if (!end.outcome) throw new Error("An upload in flight needs its outcome.");
							await tx.run(sql`UPDATE file_slot SET outcome=${end.outcome}
								WHERE job_id=${id} AND outcome='uploading'`);
						}
						const counts = await tx.get<{ posts: number; unknown: number }>(sql`SELECT
							TOTAL(outcome<>'unsent') AS posts, TOTAL(outcome='unknown') AS unknown
							FROM file_slot WHERE job_id=${id}`);
						const posts = counts?.posts ?? 0;
						const unknown = (counts?.unknown ?? 0) > 0;
						const rejected = job.file_phase === "uploading" && end.outcome === "rejected";
						const phase: FilePhase = !posts
							? "unsent"
							: unknown
								? "upload-unknown"
								: rejected
									? "upload-rejected"
									: "stored";
						const afterRead = posts > 0 && !unknown;
						return tx.get<ImageJob>(sql`UPDATE image_job SET file_phase=${phase},
							state=${unknown ? "unknown" : "rejected"},rejection=${end.rejection ?? null},
							file_stop=${end.stop ?? null},file_stop_slot=${end.slot ?? null},file_other_slot=${end.other ?? null},
							retry_at=${end.until ?? null},updated_at=${now},submission_recorded_at=${now},
							wallet_open=CASE WHEN ${posts > 0} THEN wallet_open ELSE 0 END,
							wallet_finish_by=CASE WHEN ${afterRead} AND wallet_open=1 THEN ${now + 10_000} END
							WHERE id=${id} RETURNING *`);
					},
					{ behavior: "immediate" },
				),
			);
		},
		/**
		 * A fresh runtime settles every earlier runtime's file job from its slots: an upload
		 * in flight is unknown, a restart between sends is interrupted, an edit in flight is
		 * unknown. Recovery never sends.
		 */
		recover(now: number) {
			return use((db) =>
				db.transaction(
					async (tx) => {
						const pending = await tx.all<{
							id: string;
							file_owner: string;
							file_phase: "claimed" | "uploading" | "uploaded" | "editing";
						}>(sql`SELECT id,file_owner,file_phase FROM image_job
							WHERE file_owner<>${owner} AND state='submitting' AND task_id IS NULL AND file_phase IN ('claimed','uploading','uploaded','editing')`);
						for (const prior of pending) {
							const where = sql`id=${prior.id} AND file_owner=${prior.file_owner} AND file_phase=${prior.file_phase} AND state='submitting' AND task_id IS NULL`;
							if (prior.file_phase === "uploading" || prior.file_phase === "editing") {
								if (prior.file_phase === "uploading")
									await tx.run(
										sql`UPDATE file_slot SET outcome='unknown' WHERE job_id=${prior.id} AND outcome='uploading'`,
									);
								const to = prior.file_phase === "uploading" ? "upload-unknown" : "edit-unknown";
								await tx.run(
									sql`UPDATE image_job SET file_phase=${to},state='unknown',updated_at=${now} WHERE ${where}`,
								);
								continue;
							}
							await tx.run(sql`UPDATE image_job SET file_phase=${prior.file_phase === "claimed" ? "unsent" : "stored"},
								state='rejected',updated_at=${now},wallet_open=0,file_stop='interrupted',
								file_stop_slot=(SELECT MIN(position) FROM file_slot WHERE job_id=${prior.id} AND outcome='unsent')
								WHERE ${where}`);
						}
						await tx.run(
							sql`UPDATE image_job SET wallet_open=0 WHERE file_owner<>${owner} AND state='rejected' AND wallet_open=1`,
						);
					},
					{ behavior: "immediate" },
				),
			);
		},
	};
}
