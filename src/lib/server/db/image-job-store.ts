import { sql } from "drizzle-orm";
import type { ProviderId } from "../../shared/providers/connections";
import {
	type Rejection,
	type StatusPause,
	type Submission,
	statusTimeoutMs,
	type TaskBilling,
	type TaskFailureReason,
	type TaskState,
} from "../providers/image-job";
import { markWalletOverlap } from "./image-batch-store";
import { credentialPermitsImage } from "./image-credential-access";
import { imageJobPollingWindowMs } from "./image-job-schema";
import type { Installation, InstallationTransaction } from "./installation";
import { nextProviderStart, recordProviderStart } from "./provider-gate";

export type JobState = "submitting" | "unknown" | "rejected" | TaskState;
export type StatusNote = StatusPause | "credential-changed" | "temporary" | "result-unavailable";

export type ImageJob = {
	batch_id: string | null;
	transient_failure: "service_busy" | "request_rate_limited" | null;
	slot: number | null;
	attempt: number | null;
	completion_seen: number;
	retry_state: "ready" | "watch" | "settlement" | "done" | null;
	retry_at: number | null;
	skipped: "retry-evidence" | "cooldown" | "expired" | "interrupted" | null;
	throttle: number;
	id: string;
	provider: ProviderId;
	revision: number;
	quote: string;
	state: JobState;
	model: string;
	operation: string | null;
	gallery_reason: "unsupported-image" | null;
	created_at: number;
	poll_deadline: number;
	updated_at: number | null;
	task_id: string | null;
	next_read_at: number | null;
	read_failures: number;
	pause_reason: StatusNote | null;
	rejection: Rejection | null;
	failure_reason: TaskFailureReason | null;
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
	completedObservation: boolean;
	transientFailure: ImageJob["transient_failure"];
	retry: { state: ImageJob["retry_state"]; at: number | null } | null;
	queryAfter: number;
	state: JobState;
	nextReadAt: number;
	failures: number;
	note: StatusNote | null;
	failureReason: TaskFailureReason | null;
	billing: TaskBilling | null;
	expiresAt: number | null;
};

// A balance read has a bounded timeout. Allow time to load its pinned credential first.
const walletFinishWindowMs = 2 * statusTimeoutMs;

const currentCredential = sql`EXISTS (
		SELECT 1 FROM provider_credential c WHERE c.provider=image_job.provider
			AND c.revision=image_job.revision AND c.ciphertext IS NOT NULL AND ${credentialPermitsImage(sql`image_job.model`)}
	)`;

export const jobsNeedCredential = (provider: ProviderId) => sql`(EXISTS (
	SELECT 1 FROM image_batch b JOIN provider_credential c ON c.provider=b.provider AND c.revision=b.revision
	WHERE b.provider=${provider} AND b.closed_reason IS NULL AND c.ciphertext IS NOT NULL
) OR EXISTS (
	SELECT 1 FROM image_job WHERE provider=${provider} AND ${currentCredential}
	AND (state IN ('submitting','waiting','running') OR (
		state='completed' AND NOT EXISTS (
			SELECT 1 FROM gallery_image WHERE job_id=image_job.id AND state='saved'
		)
	))
))`;

export async function skipImageSend(
	tx: InstallationTransaction,
	id: string,
	reason: NonNullable<ImageJob["skipped"]>,
	now: number,
	until: number | null,
) {
	await tx.run(sql`UPDATE image_job SET state='rejected',skipped=${reason},updated_at=${now},retry_at=${until},
		submission_recorded_at=${now},wallet_open=0,retry_state=NULL WHERE id=${id} AND submission_recorded_at IS NULL`);
}

export function imageJobStore({ use }: Installation) {
	const byId = (id: string) => sql`SELECT * FROM image_job WHERE id=${id}`;

	return {
		get: (id: string) => use((db) => db.get<ImageJob>(byId(id))),
		list: () =>
			use((db) => db.all<ImageJob>(sql`SELECT * FROM image_job ORDER BY created_at DESC, id`)),

		recover(now: number) {
			return use((db) =>
				db.transaction(
					async (tx) => {
						await tx.run(
							sql`UPDATE image_batch SET closed_reason='interrupted',closed_at=MIN(deadline,${now}) WHERE closed_reason IS NULL`,
						);
						await tx.run(sql`UPDATE image_job SET retry_state=NULL WHERE batch_id IS NOT NULL`);
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
						await markWalletOverlap(tx, now);
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

		recordSubmission(
			id: string,
			result: Submission,
			now: number,
			initialWait: number,
			throttleUntil = 0,
		) {
			return use((db) =>
				db.transaction(
					async (tx) => {
						const job = await tx.get<ImageJob>(sql`SELECT * FROM image_job WHERE id=${id}`);
						if (!job) return;

						const state: JobState =
							result.kind === "accepted"
								? "waiting"
								: result.kind === "throttled"
									? job.batch_id
										? "rejected"
										: "unknown"
									: result.kind;
						const taskId = result.kind === "accepted" ? result.taskId : null;
						const rejection = result.kind === "rejected" ? result.reason : null;
						if (job.batch_id && rejection)
							await tx.run(sql`UPDATE image_batch SET closed_reason='rejection', closed_at=${now}
					WHERE id=${job.batch_id} AND closed_reason IS NULL`);
						return tx.get<ImageJob>(sql`UPDATE image_job SET state=${state}, task_id=${taskId},
					rejection=${rejection}, next_read_at=${taskId ? now + initialWait : null},
					updated_at=${now}, submission_recorded_at=${now}, throttle=${Number(result.kind === "throttled")},
					retry_state=CASE WHEN ${taskId} IS NOT NULL THEN retry_state WHEN batch_id IS NOT NULL AND ${result.kind}='throttled' THEN 'ready' END,
					retry_at=${throttleUntil || null},
					poll_deadline=CASE WHEN ${taskId} IS NOT NULL THEN ${now + imageJobPollingWindowMs} ELSE poll_deadline END,
					wallet_finish_by=CASE WHEN batch_id IS NULL AND wallet_open=1 AND ${state}='rejected' THEN ${now + walletFinishWindowMs} END
					WHERE id=${id} AND dispatch_started_at IS NOT NULL AND submission_recorded_at IS NULL
						AND state IN ('submitting','unknown') AND task_id IS NULL RETURNING *`);
					},
					{ behavior: "immediate" },
				),
			);
		},

		finishWallet(id: string, balance: string | null, now: number) {
			return use((db) =>
				db.run(sql`UPDATE image_job SET wallet_open=0,
				wallet_after=CASE WHEN ${currentCredential} AND wallet_finish_by>${now} THEN ${balance} END,
				wallet_after_at=CASE WHEN ${currentCredential} AND wallet_finish_by>${now} AND ${balance} IS NOT NULL THEN ${now} END
				WHERE id=${id} AND wallet_open=1`),
			);
		},

		recordMissingCredential(id: string) {
			return use((db) =>
				db.run(sql`UPDATE image_job SET pause_reason='credential-changed'
				WHERE id=${id} AND task_id IS NOT NULL`),
			);
		},

		reserveRead(
			id: string,
			token: string,
			clock: () => number,
			holdMs: number,
			automatic: boolean,
		) {
			return use((db) =>
				db.transaction(
					async (tx) => {
						const now = clock();
						const holdUntil = now + holdMs;
						const automaticGuard = automatic
							? sql`AND poll_deadline>${now} AND ((state IN ('waiting','running') AND (pause_reason IS NULL OR pause_reason='temporary')) OR (retry_state IN ('settlement','watch')
					AND EXISTS (SELECT 1 FROM image_batch WHERE id=image_job.batch_id AND closed_reason IS NULL AND deadline>${now})))
					AND pause_reason IS NOT 'credential-changed'`
							: sql``;
						const job = await tx.get<ImageJob>(byId(id));
						if (!job) return;
						const until = await nextProviderStart(tx, job.provider, "query", now);
						if (until > now) {
							await tx.run(
								sql`UPDATE image_job SET next_read_at=MAX(next_read_at,${until}) WHERE id=${id}`,
							);
							return;
						}
						const reserved =
							await tx.get<ImageJob>(sql`UPDATE image_job SET read_token=${token}, next_read_at=${holdUntil}
				WHERE id=${id} AND task_id IS NOT NULL AND next_read_at<=${now}
					AND ${currentCredential} ${automaticGuard} RETURNING *`);
						if (reserved) await recordProviderStart(tx, job.provider, "query", now);
						return reserved;
					},
					{ behavior: "immediate" },
				),
			);
		},

		releaseUnread(id: string, token: string, nextReadAt: number) {
			return use((db) =>
				db.run(sql`UPDATE image_job SET read_token=NULL, next_read_at=${nextReadAt}
				WHERE id=${id} AND read_token=${token}`),
			);
		},

		recordStatus(id: string, token: string, now: number, update: StatusUpdate) {
			const retry = update.retry
				? sql`retry_state=CASE WHEN EXISTS(SELECT 1 FROM image_batch WHERE id=image_job.batch_id AND deadline>${now} AND closed_reason IS NULL)
					THEN ${update.retry.state} END, retry_at=${update.retry.at},`
				: sql``;
			return use((db) =>
				db.transaction(
					async (tx) => {
						const saved = await tx.get<ImageJob>(sql`UPDATE image_job SET state=${update.state},
				next_read_at=${update.nextReadAt}, read_token=NULL, read_failures=${update.failures},
				completion_seen=MAX(completion_seen,${Number(update.completedObservation)}),
				${retry} pause_reason=${update.note}, billing=${update.billing && JSON.stringify(update.billing)},
				transient_failure=COALESCE(${update.transientFailure},transient_failure),failure_reason=COALESCE(${update.failureReason}, failure_reason),
				expires_at=${update.expiresAt}, updated_at=${now},
				wallet_finish_by=CASE WHEN batch_id IS NULL AND wallet_open=1 AND state IN ('waiting','running')
					AND ${update.state} IN ('completed','failed') THEN ${now + walletFinishWindowMs} ELSE wallet_finish_by END
				WHERE id=${id} AND read_token=${token} RETURNING *`);
						if (saved && update.queryAfter > now)
							await tx.run(
								sql`UPDATE provider_gate SET query_after=MAX(query_after,${update.queryAfter}) WHERE provider=${saved.provider}`,
							);
						return saved;
					},
					{ behavior: "immediate" },
				),
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
