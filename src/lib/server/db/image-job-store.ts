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
import type { FilePhase, FileStop } from "./file-attempt";
import { markWalletOverlap } from "./image-batch-store";
import {
	type CredentialAccess,
	credentialPermitsImage,
	imageCredentialAccess,
} from "./image-credential-access";
import { imageJobPollingWindowMs } from "./image-job-schema";
import type { Installation, InstallationTransaction } from "./installation";
import { nextProviderStart, recordProviderStart } from "./provider-gate";
import { videoJobPollingWindowMs } from "./video-schema";

export type JobState = "submitting" | "unknown" | "rejected" | TaskState;
export type StatusNote =
	| StatusPause
	| "credential-changed"
	| "temporary"
	| "result-unavailable"
	| "unsupported-video-result";

export type SaveHold = "removed" | "unsupported" | "webm" | "failed";

/** A note that stops status reads until Refresh. A temporary or link-less read does not. */
export function isReadPaused(note: StatusNote | null) {
	return note !== null && note !== "temporary" && note !== "result-unavailable";
}
const unpausedSql = sql`(image_job.pause_reason IS NULL OR image_job.pause_reason IN ('temporary','result-unavailable'))`;

export type ImageJob = {
	/** A local-file edit's upload and edit boundary (null for every other job). */
	file_phase: FilePhase | null;
	file_owner: string | null;
	/** Every reference of a file job, URLs included. */
	file_references: number | null;
	file_stop: FileStop | null;
	/** 1-based reference positions a stop names. */
	file_stop_slot: number | null;
	file_other_slot: number | null;
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
	/** A pending automatic Save and the earliest time the worker may act on it (D9). */
	save_due: number | null;
	save_hold: SaveHold | null;
	/** The claimed attempt's token: the fence for its outcome and its scratch name. */
	save_attempt: string | null;
	save_tries: number;
	created_at: number;
	poll_deadline: number;
	business_id: string | null;
	video_terms: string | null;
	submission_recorded_at: number | null;
	video_poll_deadline: number | null;
	video_progress: number | null;
	video_observation_id: string | null;
	read_token: string | null;
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

type JobKind = Partial<Pick<ImageJob, "business_id" | "video_terms">>;

/** A Video Queue job. Rows from before Poyo video carry only a ToAPIs correlation ID. */
export function isVideoJob(job: JobKind | undefined) {
	return !!job && (job.video_terms != null || job.business_id != null);
}

/** A ToAPIs correlation ID: lookup without a task ID, identity checks and settled billing. */
export function hasCorrelation(job: JobKind) {
	return job.business_id != null;
}

export type JobCredentialScope = Pick<ImageJob, "provider" | "revision" | "model"> & JobKind;

export function jobCredentialAccess(job: JobCredentialScope): CredentialAccess {
	if (isVideoJob(job)) return job.provider === "poyo" ? "poyo-balance" : "toapis-video";
	return imageCredentialAccess(job.provider, job.model);
}

type DeadlineScope = JobKind &
	Pick<ImageJob, "video_poll_deadline" | "poll_deadline" | "submission_recorded_at" | "task_id">;

/**
 * The automatic polling deadline. A ToAPIs video stores its own. A Poyo video keeps
 * video_poll_deadline NULL (its CHECK requires a correlation ID), so the video window runs
 * from its durable acknowledgement. Before an acknowledgement the image window applies.
 */
export function jobPollDeadline(job: DeadlineScope) {
	if (job.video_poll_deadline != null) return job.video_poll_deadline;
	return isVideoJob(job) && job.submission_recorded_at != null && job.task_id != null
		? job.submission_recorded_at + videoJobPollingWindowMs
		: job.poll_deadline;
}

const videoJobSql = sql`(image_job.video_terms IS NOT NULL OR image_job.business_id IS NOT NULL)`;
/** The SQL twin of jobPollDeadline over image_job. */
export const pollDeadlineSql = sql`COALESCE(image_job.video_poll_deadline,
	CASE WHEN ${videoJobSql} AND image_job.task_id IS NOT NULL AND image_job.submission_recorded_at IS NOT NULL
		THEN image_job.submission_recorded_at+${videoJobPollingWindowMs} END,
	image_job.poll_deadline)`;

type StatusUpdate = {
	completedObservation: boolean;
	transientFailure: ImageJob["transient_failure"];
	retry: { state: ImageJob["retry_state"]; at: number | null } | null;
	queryAfter: number;
	progress?: number | null;
	recoveredTask?: string;
	lookup?: boolean;
	state: JobState;
	nextReadAt: number;
	failures: number;
	note: StatusNote | null;
	failureReason: TaskFailureReason | null;
	billing: TaskBilling | null;
	expiresAt: number | null;
	/** What a first completion records instead of an intent when its read has no usable link (D9). */
	saveHold: SaveHold | null;
};

// A balance read has a bounded timeout. Allow time to load its pinned credential first.
const walletFinishWindowMs = 2 * statusTimeoutMs;

export const currentCredential = sql`EXISTS (
		SELECT 1 FROM provider_credential c WHERE c.provider=image_job.provider
			AND c.revision=image_job.revision AND c.ciphertext IS NOT NULL AND (${credentialPermitsImage(sql`image_job.model`)} OR ${videoJobSql})
	)`;

/** No Gallery item, saved or not, belongs to this job. */
export const noGalleryItemSql = sql`NOT EXISTS (SELECT 1 FROM gallery_image g WHERE g.job_id=image_job.id)`;
/** A completed result the creator may retry: its link has not expired and reads are not paused. */
export const retryableSql = (now: number) =>
	sql`image_job.state='completed' AND (image_job.expires_at IS NULL OR image_job.expires_at>${now}) AND ${unpausedSql}`;

export const jobsNeedCredential = (provider: ProviderId, now: number) => sql`(EXISTS (
	SELECT 1 FROM image_batch b JOIN provider_credential c ON c.provider=b.provider AND c.revision=b.revision
	WHERE b.provider=${provider} AND b.closed_reason IS NULL AND c.ciphertext IS NOT NULL
) OR EXISTS (
	SELECT 1 FROM image_job WHERE provider=${provider} AND ${currentCredential}
	AND (state IN ('submitting','waiting','running') OR (state='unknown' AND business_id IS NOT NULL) OR (
		state='completed' AND (expires_at IS NULL OR expires_at>${now}) AND ${noGalleryItemSql}
		AND ((save_due IS NOT NULL AND save_hold IS NULL) OR save_hold='failed')
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
		submission_recorded_at=${now},wallet_open=0,retry_state=NULL WHERE id=${id} AND file_phase IS NULL AND state='submitting' AND submission_recorded_at IS NULL`);
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
						// File attempts recover through their own phases first.
						await tx.run(sql`UPDATE image_job SET state='unknown', updated_at=${now}
						WHERE state='submitting' AND file_phase IS NULL AND task_id IS NULL`);
						// A second server can start while a live server finishes its after-balance.
						await tx.run(sql`UPDATE image_job SET wallet_open=0
						WHERE wallet_open=1 AND wallet_finish_by<=${now}`);
					},
					{ behavior: "immediate" },
				),
			);
		},

		beginDispatch(id: string, provider: ProviderId, now: number, fileOwner?: string) {
			return use((db) =>
				db.transaction(
					async (tx) => {
						const job = await tx.get<{ id: string }>(sql`UPDATE image_job
						SET dispatch_started_at=${now}, updated_at=${now}, wallet_open=${Number(provider === "poyo")}
						WHERE id=${id} AND provider=${provider} AND state='submitting' AND dispatch_started_at IS NULL
						AND ${fileOwner ? sql`file_owner=${fileOwner} AND file_phase='claimed'` : sql`file_phase IS NULL`}
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
			fileOwner?: string,
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
					file_phase=${fileOwner ? (state === "unknown" ? "edit-unknown" : "edit-recorded") : null},
					rejection=${rejection}, next_read_at=CASE WHEN business_id IS NOT NULL THEN MAX(COALESCE(next_read_at,0),${now + initialWait}) ELSE ${taskId ? now + initialWait : null} END,
				video_poll_deadline=CASE WHEN business_id IS NOT NULL AND ${taskId} IS NOT NULL THEN ${now + videoJobPollingWindowMs} END,
					updated_at=${now}, submission_recorded_at=${now}, throttle=${Number(result.kind === "throttled")},
					retry_state=CASE WHEN ${taskId} IS NOT NULL THEN retry_state WHEN batch_id IS NOT NULL AND ${result.kind}='throttled' THEN 'ready' END,
					retry_at=${throttleUntil || null},
					poll_deadline=CASE WHEN ${taskId} IS NOT NULL THEN ${now + imageJobPollingWindowMs} ELSE poll_deadline END,
					wallet_finish_by=CASE WHEN batch_id IS NULL AND wallet_open=1 AND ${state}='rejected' THEN ${now + walletFinishWindowMs} END
					WHERE id=${id} AND dispatch_started_at IS NOT NULL AND submission_recorded_at IS NULL
						AND ${fileOwner ? sql`file_owner=${fileOwner} AND file_phase='editing'` : sql`file_phase IS NULL`}
						AND state IN ('submitting','unknown') AND task_id IS NULL RETURNING *`);
					},
					{ behavior: "immediate" },
				),
			);
		},

		/** Whether a file attempt's dispatcher may still read the closing balance under its key. */
		canReadFileWallet(id: string, owner: string, now: number) {
			return use((db) =>
				db.get(sql`SELECT 1 FROM image_job WHERE id=${id} AND file_owner=${owner}
				AND wallet_open=1 AND wallet_finish_by>${now} AND ${currentCredential}`),
			);
		},

		finishWallet(id: string, balance: string | null, now: number, fileOwner?: string) {
			return use((db) =>
				db.run(sql`UPDATE image_job SET wallet_open=0,
				wallet_after=CASE WHEN ${currentCredential} AND wallet_finish_by>${now} THEN ${balance} END,
				wallet_after_at=CASE WHEN ${currentCredential} AND wallet_finish_by>${now} AND ${balance} IS NOT NULL THEN ${now} END
				WHERE id=${id} AND wallet_open=1 ${fileOwner ? sql`AND file_owner=${fileOwner}` : sql.empty()}`),
			);
		},

		recordMissingCredential(id: string) {
			return use((db) =>
				db.run(sql`UPDATE image_job SET pause_reason='credential-changed'
				WHERE id=${id} AND (task_id IS NOT NULL OR business_id IS NOT NULL)`),
			);
		},

		reserveRead(
			id: string,
			token: string,
			clock: () => number,
			holdMs: number,
			automatic: boolean,
			lookup?: ImageJob,
		) {
			return use((db) =>
				db.transaction(
					async (tx) => {
						const now = clock();
						const holdUntil = now + holdMs;
						const automaticGuard = automatic
							? sql`AND ${pollDeadlineSql}>${now} AND ((state IN ('waiting','running') AND (pause_reason IS NULL OR pause_reason='temporary')) OR (retry_state IN ('settlement','watch')
					AND EXISTS (SELECT 1 FROM image_batch WHERE id=image_job.batch_id AND closed_reason IS NULL AND deadline>${now})))
					AND pause_reason IS NOT 'credential-changed'`
							: sql``;
						const job = await tx.get<ImageJob>(byId(id));
						if (!job) return;
						const until = await nextProviderStart(tx, job.provider, "query", now);
						if (until > now) {
							await tx.run(
								sql`UPDATE image_job SET next_read_at=MAX(COALESCE(next_read_at,created_at+5000),${until}) WHERE id=${id}`,
							);
							return;
						}
						const identity = lookup
							? sql`business_id=${lookup.business_id} AND revision=${lookup.revision} AND state='unknown' AND task_id IS NULL`
							: sql`task_id IS NOT NULL`;
						const reserved =
							await tx.get<ImageJob>(sql`UPDATE image_job SET read_token=${token}, next_read_at=${holdUntil}
				WHERE id=${id} AND ${identity} AND COALESCE(next_read_at,created_at+5000)<=${now}
					AND ${currentCredential} ${automaticGuard} RETURNING *`);
						if (reserved) await recordProviderStart(tx, job.provider, "query", now);
						return reserved;
					},
					{ behavior: "immediate" },
				),
			);
		},

		async identityConflict(id: string, taskId: string) {
			await use((db) =>
				db.run(
					sql`UPDATE image_job SET pause_reason='unknown-status' WHERE id=${id} AND business_id IS NOT NULL AND task_id IS NOT NULL AND task_id<>${taskId}`,
				),
			);
		},
		releaseUnread(id: string, token: string, nextReadAt: number) {
			return use((db) =>
				db.run(sql`UPDATE image_job SET read_token=NULL, next_read_at=${nextReadAt}
				WHERE id=${id} AND read_token=${token}`),
			);
		},

		recordStatus({ id, provider }: ImageJob, token: string, now: number, update: StatusUpdate) {
			const retry = update.retry
				? sql`retry_state=CASE WHEN EXISTS(SELECT 1 FROM image_batch WHERE id=image_job.batch_id AND deadline>${now} AND closed_reason IS NULL)
					THEN ${update.retry.state} END, retry_at=${update.retry.at},`
				: sql``;
			return use((db) =>
				db.transaction(
					async (tx) => {
						const previous = await tx.get<Pick<ImageJob, "state" | "save_due" | "pause_reason">>(
							sql`SELECT state, save_due, pause_reason FROM image_job WHERE id=${id}`,
						);
						// The first transition into completed records the intent to save, or its hold (D9).
						const first = sql`state<>'completed' AND ${update.state}='completed' AND save_hold IS NULL
					AND ${noGalleryItemSql}`;
						// A later read (recovery, Retry or Refresh) that finds an unsupported clip holds a
						// pending intent the same way; no download of that result can succeed.
						const unsupported = sql`state='completed' AND ${update.state}='completed'
					AND ${update.saveHold}='unsupported' AND save_due IS NOT NULL AND save_hold IS NULL
					AND ${noGalleryItemSql}`;
						const saved = await tx.get<ImageJob>(sql`UPDATE image_job SET state=${update.state},
				save_due=CASE WHEN ${first} THEN CASE WHEN ${update.saveHold} IS NULL THEN ${now} END
					WHEN ${unsupported} THEN NULL ELSE save_due END,
				save_hold=CASE WHEN ${first} THEN ${update.saveHold} WHEN ${unsupported} THEN 'unsupported'
					ELSE save_hold END,
				task_id=COALESCE(task_id,${update.recoveredTask ?? null}),
				submission_recorded_at=CASE WHEN task_id IS NULL AND ${update.recoveredTask ?? null} IS NOT NULL THEN ${now} ELSE submission_recorded_at END,
				poll_deadline=CASE WHEN task_id IS NULL AND ${update.recoveredTask ?? null} IS NOT NULL THEN ${now + imageJobPollingWindowMs} ELSE poll_deadline END,
				video_poll_deadline=CASE WHEN task_id IS NULL AND ${update.recoveredTask ?? null} IS NOT NULL THEN ${now + videoJobPollingWindowMs} ELSE video_poll_deadline END,
				video_observation_id=CASE WHEN ${videoJobSql} THEN ${token} END,
				video_progress=COALESCE(${update.progress ?? null},video_progress),
				next_read_at=${update.nextReadAt}, read_token=NULL, read_failures=${update.failures},
				completion_seen=MAX(completion_seen,${Number(update.completedObservation)}),
				${retry} pause_reason=${update.note}, billing=${update.billing && JSON.stringify(update.billing)},
				transient_failure=COALESCE(${update.transientFailure},transient_failure),failure_reason=COALESCE(${update.failureReason}, failure_reason),
				expires_at=${update.expiresAt}, updated_at=${now},
				wallet_finish_by=CASE WHEN batch_id IS NULL AND wallet_open=1 AND state IN ('waiting','running')
					AND ${update.state} IN ('completed','failed') THEN ${now + walletFinishWindowMs} ELSE wallet_finish_by END
				WHERE id=${id} AND read_token=${token} AND (NOT ${videoJobSql} OR ${currentCredential}) AND (${!update.lookup ? 1 : 0} OR (state='unknown' AND task_id IS NULL) OR task_id=${update.recoveredTask ?? null}) RETURNING *`);
						if (update.queryAfter > now)
							await tx.run(
								sql`UPDATE provider_gate SET query_after=MAX(query_after,${update.queryAfter}) WHERE provider=${provider}`,
							);
						if (!saved || !previous) return;
						// Computed from the values before and after this read, not from RETURNING alone.
						const armed =
							previous.state !== "completed" &&
							previous.save_due === null &&
							saved.state === "completed" &&
							saved.save_due !== null;
						// An earlier completion's intent is still waiting for the worker.
						const pending =
							!armed &&
							previous.state === "completed" &&
							saved.state === "completed" &&
							saved.save_due !== null &&
							saved.save_hold === null &&
							!(await tx.get(sql`SELECT 1 FROM gallery_image WHERE job_id=${id}`));
						const resumed =
							pending && isReadPaused(previous.pause_reason) && !isReadPaused(saved.pause_reason);
						return { job: saved, armed, pending, resumed };
					},
					{ behavior: "immediate" },
				),
			);
		},

		async needsCredential(provider: ProviderId, now: number) {
			const row = await use((db) =>
				db.get<{ needed: number }>(sql`SELECT ${jobsNeedCredential(provider, now)} AS needed`),
			);
			return row?.needed === 1;
		},
	};
}
