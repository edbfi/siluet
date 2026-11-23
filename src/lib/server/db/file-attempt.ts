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
const nextPhase = { claimed: "uploading", uploading: "uploaded", uploaded: "editing" } as const;
const interrupted = {
	claimed: "unsent",
	uploading: "upload-unknown",
	uploaded: "stored",
	editing: "edit-unknown",
} as const;
export async function advanceFilePhase(
	tx: Pick<InstallationTransaction, "get">,
	id: string,
	owner: string,
	from: keyof typeof nextPhase,
	now: number,
) {
	return !!(await tx.get(
		sql`UPDATE image_job SET file_phase=${nextPhase[from]},updated_at=${now} WHERE id=${id} AND file_phase=${from} AND file_owner=${owner} AND state='submitting' RETURNING id`,
	));
}
export async function undoFilePhase(
	tx: InstallationTransaction,
	id: string,
	owner: string,
	from: "claimed" | "uploaded",
	time: number,
) {
	const restored = await tx.get(sql`UPDATE image_job SET file_phase=${from}
		WHERE id=${id} AND file_owner=${owner} AND file_phase=${nextPhase[from]}
		AND updated_at=${time} AND state='submitting' RETURNING id`);
	if (!restored) throw new Error("File dispatch marker changed.");
}

export function fileAttemptStore({ use }: Installation, owner: string) {
	return {
		advance(id: string, from: keyof typeof nextPhase, now: number) {
			return use((db) => advanceFilePhase(db, id, owner, from, now));
		},
		stopBeforeSend(
			id: string,
			from: "claimed" | "uploaded",
			now: number,
			until: number | null = null,
		) {
			const stored = from === "uploaded";
			return use((db) =>
				db.get<ImageJob>(sql`UPDATE image_job SET file_phase=${stored ? "stored" : "unsent"},state='rejected',updated_at=${now},submission_recorded_at=${now},retry_at=${until},
				wallet_open=CASE WHEN ${stored} THEN wallet_open ELSE 0 END,
				wallet_finish_by=CASE WHEN ${stored} AND wallet_open=1 THEN ${now + 10000} END
				WHERE id=${id} AND file_owner=${owner} AND file_phase=${from} AND state='submitting' RETURNING *`),
			);
		},
		endUpload(
			id: string,
			phase: "upload-unknown" | "upload-rejected" | "stored",
			reason: Rejection | null,
			now: number,
		) {
			const unknown = phase === "upload-unknown";
			return use((db) =>
				db.get<ImageJob>(sql`UPDATE image_job SET file_phase=${phase}, state=${unknown ? "unknown" : "rejected"},rejection=${reason},updated_at=${now},submission_recorded_at=${now},
			wallet_finish_by=CASE WHEN wallet_open=1 AND ${!unknown} THEN ${now + 10_000} END
			WHERE id=${id} AND file_owner=${owner} AND file_phase='uploading' RETURNING *`),
			);
		},
		recover(now: number) {
			return use((db) =>
				db.transaction(
					async (tx) => {
						const pending = await tx.all<{
							id: string;
							file_owner: string;
							file_phase: keyof typeof interrupted;
						}>(sql`SELECT id,file_owner,file_phase FROM image_job
							WHERE file_owner<>${owner} AND state='submitting' AND task_id IS NULL AND file_phase IN ('claimed','uploading','uploaded','editing')`);
						for (const prior of pending) {
							const to = interrupted[prior.file_phase];
							const uncertain = to === "upload-unknown" || to === "edit-unknown";
							await tx.run(sql`UPDATE image_job SET file_phase=${to},state=${uncertain ? "unknown" : "rejected"},updated_at=${now},wallet_open=CASE WHEN ${uncertain} THEN wallet_open ELSE 0 END
								WHERE id=${prior.id} AND file_owner=${prior.file_owner} AND file_phase=${prior.file_phase} AND state='submitting' AND task_id IS NULL`);
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
