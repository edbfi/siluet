import { sql } from "drizzle-orm";
import type { ProviderId } from "../../shared/providers/connections";
import {
	type Rejection,
	type StatusPause,
	type Submission,
	statusTimeoutMs,
	type TaskBilling,
	type TaskState,
} from "../providers/image-job";
import { imageJobPollingWindowMs } from "./image-job-schema";
import type { Installation } from "./installation";

export type JobState = "submitting" | "unknown" | "rejected" | TaskState;
export type StatusNote = StatusPause | "credential-changed" | "temporary" | "result-unavailable";

export type ImageJob = {
	id: string;
	provider: ProviderId;
	revision: number;
	quote: string;
	state: JobState;
	model: string;
	created_at: number;
	poll_deadline: number;
	updated_at: number | null;
	task_id: string | null;
	next_read_at: number | null;
	read_failures: number;
	pause_reason: StatusNote | null;
	rejection: Rejection | null;
	billing: string | null;
	expires_at: number | null;
	wallet_open: number;
	wallet_overlap: number;
	wallet_finish_by: number | null;
	wallet_before: string | null;
	wallet_before_at: number | null;
	wallet_after: string | null;
	wallet_after_at: number | null;
};

type StatusUpdate = {
	state: JobState;
	nextReadAt: number;
	failures: number;
	note: StatusNote | null;
	billing: TaskBilling | null;
	expiresAt: number | null;
};

// A balance read has a bounded timeout. Allow time to load its pinned credential first.
const walletFinishWindowMs = 2 * statusTimeoutMs;

const currentCredential = sql`EXISTS (
		SELECT 1 FROM provider_credential c WHERE c.provider=image_job.provider
			AND c.revision=image_job.revision AND c.ciphertext IS NOT NULL AND c.seedream=1
	)`;

export const jobsNeedCredential = (provider: ProviderId) => sql`EXISTS (
	SELECT 1 FROM image_job WHERE provider=${provider} AND ${currentCredential}
	AND (state IN ('submitting','waiting','running') OR (
		state='completed' AND NOT EXISTS (
			SELECT 1 FROM gallery_image WHERE job_id=image_job.id AND state='saved'
		)
	))
)`;

export function imageJobStore({ use }: Installation) {
	const byId = (id: string) => sql`SELECT * FROM image_job WHERE id=${id}`;
	const unfinishedWallet = (now: number) =>
		sql`provider='poyo' AND wallet_open=1 AND (wallet_finish_by IS NULL OR wallet_finish_by>${now})`;

	return {
		get: (id: string) => use((db) => db.get<ImageJob>(byId(id))),
		list: () =>
			use((db) => db.all<ImageJob>(sql`SELECT * FROM image_job ORDER BY created_at DESC, id`)),

		recover(now: number) {
			return use((db) =>
				db.transaction(
					async (tx) => {
						// An interrupted attempt may have been accepted without a durable task ID.
						await tx.run(sql`UPDATE image_job SET state='unknown', updated_at=${now}
						WHERE state='submitting' AND task_id IS NULL`);
						// A second server can start while a live server finishes its after-balance.
						await tx.run(sql`UPDATE image_job SET wallet_open=0
						WHERE wallet_open=1 AND wallet_finish_by<=${now}`);
					},
					{ behavior: "immediate" },
				),
			);
		},

		beginDispatch(id: string, provider: ProviderId, now: number) {
			return use((db) =>
				db.transaction(
					async (tx) => {
						const job = await tx.get<{ id: string }>(sql`UPDATE image_job
						SET dispatch_started_at=${now}, updated_at=${now}, wallet_open=${Number(provider === "poyo")}
						WHERE id=${id} AND provider=${provider} AND state='submitting' AND dispatch_started_at IS NULL
						RETURNING id`);
						if (!job || provider !== "poyo") return job;
						// Replacement keys can still debit the same wallet. An uncertain send
						// stays open because the provider's terminal outcome is unverified.
						await tx.run(sql`UPDATE image_job SET wallet_overlap=1
						WHERE ${unfinishedWallet(now)}
						AND EXISTS (SELECT 1 FROM image_job WHERE id<>${id} AND ${unfinishedWallet(now)})`);
						return job;
					},
					{ behavior: "immediate" },
				),
			);
		},

		recordBefore(id: string, balance: string | null, now: number) {
			return use((db) =>
				db.run(sql`UPDATE image_job SET wallet_before=${balance},
				wallet_before_at=${balance === null ? null : now}
				WHERE id=${id} AND dispatch_started_at IS NOT NULL AND submission_recorded_at IS NULL
					AND state IN ('submitting','unknown')`),
			);
		},

		recordSubmission(id: string, result: Submission, now: number, initialWait: number) {
			const state: JobState = result.kind === "accepted" ? "waiting" : result.kind;
			const taskId = result.kind === "accepted" ? result.taskId : null;
			const rejection = result.kind === "rejected" ? result.reason : null;
			// A startup-inferred unknown can still receive the original live dispatch's response.
			// A recorded outcome, including provider uncertainty, is final for this attempt.
			return use((db) =>
				db.get<ImageJob>(sql`UPDATE image_job SET state=${state}, task_id=${taskId},
				rejection=${rejection}, next_read_at=${taskId ? now + initialWait : null},
				updated_at=${now}, submission_recorded_at=${now},
				poll_deadline=CASE WHEN ${taskId} IS NOT NULL THEN ${now + imageJobPollingWindowMs} ELSE poll_deadline END,
				wallet_finish_by=CASE WHEN wallet_open=1 AND ${state}='rejected' THEN ${now + walletFinishWindowMs} END
				WHERE id=${id} AND dispatch_started_at IS NOT NULL AND submission_recorded_at IS NULL
					AND state IN ('submitting','unknown') AND task_id IS NULL RETURNING *`),
			);
		},

		finishWallet(id: string, balance: string | null, now: number) {
			return use((db) =>
				db.run(sql`UPDATE image_job SET wallet_open=0,
				wallet_after=CASE WHEN wallet_finish_by>${now} THEN ${balance} END,
				wallet_after_at=CASE WHEN wallet_finish_by>${now} AND ${balance} IS NOT NULL THEN ${now} END
				WHERE id=${id} AND wallet_open=1`),
			);
		},

		recordMissingCredential(id: string) {
			return use((db) =>
				db.run(sql`UPDATE image_job SET pause_reason='credential-changed'
				WHERE id=${id} AND task_id IS NOT NULL`),
			);
		},

		reserveRead(id: string, token: string, now: number, holdUntil: number, automatic: boolean) {
			const automaticGuard = automatic
				? sql`AND poll_deadline>${now} AND state IN ('waiting','running')
					AND (pause_reason IS NULL OR pause_reason='temporary')`
				: sql``;
			return use((db) =>
				db.get<ImageJob>(sql`UPDATE image_job SET read_token=${token}, next_read_at=${holdUntil}
				WHERE id=${id} AND task_id IS NOT NULL AND next_read_at<=${now}
					AND ${currentCredential} ${automaticGuard} RETURNING *`),
			);
		},

		releaseUnread(id: string, token: string, nextReadAt: number) {
			return use((db) =>
				db.run(sql`UPDATE image_job SET read_token=NULL, next_read_at=${nextReadAt}
				WHERE id=${id} AND read_token=${token}`),
			);
		},

		recordStatus(id: string, token: string, now: number, update: StatusUpdate) {
			return use((db) =>
				db.get<ImageJob>(sql`UPDATE image_job SET state=${update.state},
				next_read_at=${update.nextReadAt}, read_token=NULL, read_failures=${update.failures},
				pause_reason=${update.note}, billing=${update.billing && JSON.stringify(update.billing)},
				expires_at=${update.expiresAt}, updated_at=${now},
				wallet_finish_by=CASE WHEN wallet_open=1 AND state IN ('waiting','running')
					AND ${update.state} IN ('completed','failed') THEN ${now + walletFinishWindowMs} ELSE wallet_finish_by END
				WHERE id=${id} AND read_token=${token} RETURNING *`),
			);
		},

		async needsCredential(provider: ProviderId) {
			const row = await use((db) =>
				db.get<{ needed: number }>(sql`SELECT ${jobsNeedCredential(provider)} AS needed`),
			);
			return row?.needed === 1;
		},
	};
}
