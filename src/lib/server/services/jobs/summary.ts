import { reconcileWallet, type WalletScope } from "../../../shared/billing/wallet";
import type { PriceEstimate } from "../../../shared/pricing/estimate";
import type { ProviderId } from "../../../shared/providers/connections";
import {
	hasCorrelation,
	type ImageJob,
	isReadPaused,
	isVideoJob,
	type JobState,
	jobPollDeadline,
	type StatusNote,
} from "../../db/image-job-store";
import type { Rejection, TaskBilling } from "../../providers/image-job";

type JobWallet =
	| {
			status: "observed";
			before: string;
			after: string;
			afterAt: number;
			beforeAt: number;
			delta: string;
	  }
	| { status: "unavailable"; reason: "missing" | "overlap" | "uncertain" };

/** Where a completed result stands in the local Gallery (D9), most decisive first. */
export type LibraryState =
	| "saved"
	| "unavailable"
	| "removed"
	| "unsupported"
	| "webm"
	| "failed"
	| "expired"
	| "needs-key"
	| "paused"
	| "saving"
	| "waiting"
	| "none";
/** The job's Gallery row, if any. */
export type GalleryState = "saved" | "unavailable" | "deleting" | null;

export type JobSummary = {
	batchId: string | null;
	slot: number | null;
	attempt: number | null;
	taskId: string | null;
	throttled: boolean;
	retryPending: boolean;
	skipped: ImageJob["skipped"];
	id: string;
	provider: ProviderId;
	model: string;
	operation: ImageJob["operation"];
	/** A local-file edit's upload and edit boundary. */
	filePhase?: NonNullable<ImageJob["file_phase"]>;
	state: JobState | "unsent";
	createdAt: number;
	updatedAt: number;
	pollDeadline: number;
	nextReadAt: number | null;
	/** A pending provider cooldown from a skipped job or a throttled video submission. A fresh Review can queue after it. */
	submitAfter: number | null;
	tracking: "automatic" | "manual" | "paused" | "done";
	message: string | null;
	quote: PriceEstimate;
	billing: TaskBilling | null;
	wallet: JobWallet | null;
	expiresAt: number | null;
	canRefresh: boolean;
	canLookup: boolean;
	progress: number | null;
	library: LibraryState;
	/** Retry download or Download again may arm this job now. */
	retryable: boolean;
	video: boolean;
};

const rejections: Record<Rejection, string> = {
	permission: "Poyo.ai refused this model for this key. The saved key is unchanged.",
	authorization: "The provider rejected the API key or its permissions.",
	validation: "The provider rejected the request parameters.",
	quota: "The provider rejected the submission because of insufficient credits or quota.",
	filtering: "The provider rejected the submission during content review.",
};

const statusNotes: Record<StatusNote, string> = {
	authorization:
		"The provider denied access to this task. Check the original API key and its permissions.",
	"missing-task":
		"The provider could not find this task. Check provider history before reviewing another request.",
	"unknown-status":
		"The provider returned an unrecognized task status. Refresh status to check again.",
	"credential-changed":
		"Status and downloads of unsaved results require the original API key for this job.",
	temporary: "The provider status is temporarily unavailable.",
	"unsupported-video-result":
		"The provider returned an unsupported video result. Check provider history.",
	"result-unavailable":
		"The provider has no usable image link. Try again or check provider history.",
};

export function isActive(job: ImageJob) {
	return job.state === "waiting" || job.state === "running";
}

export function storedBilling(job: ImageJob): TaskBilling | null {
	if (!job.billing) return null;
	const billing = JSON.parse(job.billing) as TaskBilling;
	if (!hasCorrelation(job) && (billing.status === "settled" || billing.status === "refunded")) {
		if (billing.credits === null || billing.usd === null) return { status: "unknown" };
		if (
			billing.status === "refunded" &&
			(/[1-9]/.test(billing.credits) || /[1-9]/.test(billing.usd))
		)
			return { status: "conflicting" };
	}
	return billing;
}

function walletSummary(job: ImageJob): JobWallet | null {
	if (job.provider !== "poyo") return null;
	if (job.state === "unknown") return { status: "unavailable", reason: "uncertain" };
	if (job.wallet_overlap) return { status: "unavailable", reason: "overlap" };
	if (
		!job.wallet_before ||
		!job.wallet_after ||
		job.wallet_before_at === null ||
		job.wallet_after_at === null
	)
		return job.state === "completed" || job.state === "failed" || job.state === "rejected"
			? { status: "unavailable", reason: "missing" }
			: null;
	const scope: WalletScope = { account: String(job.revision), provider: "poyo", unit: "credits" };
	const comparison = reconcileWallet({
		scope,
		before: { ...scope, amount: job.wallet_before, observedAt: job.wallet_before_at },
		after: { ...scope, amount: job.wallet_after, observedAt: job.wallet_after_at },
		startedAt: job.wallet_before_at,
		finishedAt: job.wallet_after_at,
		overlaps: false,
	});
	return comparison.status === "observed"
		? {
				status: "observed",
				before: comparison.before.amount,
				beforeAt: comparison.before.observedAt,
				afterAt: comparison.after.observedAt,
				after: comparison.after.amount,
				delta: comparison.delta,
			}
		: { status: "unavailable", reason: "missing" };
}

function libraryState(
	job: ImageJob,
	gallery: GalleryState,
	readable: boolean,
	expired: boolean,
): LibraryState {
	if (job.state !== "completed") return "none";
	if (gallery === "saved") return "saved";
	if (gallery === "unavailable") return "unavailable";
	if (job.save_hold) return job.save_hold;
	if (expired) return "expired";
	if (job.save_due === null) return "none";
	if (!readable) return "needs-key";
	// A read pause stops automatic Save until Refresh; nothing polls.
	if (isReadPaused(job.pause_reason)) return "paused";
	return job.save_attempt ? "saving" : "waiting";
}

export function summarizeJob(
	job: ImageJob,
	readable: boolean,
	now: number,
	gallery: GalleryState = null,
): JobSummary {
	const canRefresh = job.task_id !== null && readable;
	const expired = job.expires_at !== null && job.expires_at <= now;
	const library = libraryState(job, gallery, canRefresh, expired);
	const lookupPending = hasCorrelation(job) && job.state === "unknown";
	const video = isVideoJob(job);
	const note =
		(job.task_id || lookupPending) && !readable ? "credential-changed" : job.pause_reason;
	let message = note ? statusNotes[note] : null;
	if (job.rejection)
		message =
			job.provider === "toapis" && video && job.rejection === "authorization"
				? "ToAPIs denied this submission."
				: rejections[job.rejection];
	if (video && note === "unknown-status")
		message = "Task identity or status could not be verified. Check provider history.";
	if (video && note === "result-unavailable")
		message = "No usable video result was available. Check provider history or Retry download.";
	if (job.state === "unknown") {
		if (note === "missing-task") message = "The provider could not find this task.";
		if (lookupPending && note === "unknown-status")
			message = "Task identity or status could not be verified.";
		const warning =
			"This attempt may still cost credits. Check provider history before authorizing another request.";
		message = message ? `${message} ${warning}` : warning;
	}
	if ((job.file_phase === "unsent" || job.file_phase === "stored") && job.retry_at !== null)
		message = `Provider cooldown until ${new Date(job.retry_at).toISOString()}. Review again before queuing.`;
	else if (job.skipped === "retry-evidence")
		message = "Not submitted. New task evidence ruled out this retry.";
	else if (job.skipped)
		message =
			job.skipped === "cooldown"
				? "Not submitted. A provider cooldown was active. Review again before queuing."
				: "Not submitted. The dispatch window closed before sending.";
	else if (job.throttle && job.batch_id) message = "Not admitted · throttled";
	if (job.state === "failed") {
		if (job.transient_failure) {
			const reason =
				job.transient_failure === "service_busy"
					? "The provider reported that its service was busy."
					: "The provider reported a task rate limit.";
			message = message ? `${reason} ${message}` : reason;
		} else if (job.failure_reason === "reference_media_unreadable") {
			const failure = "The provider could not read one or more reference images.";
			message = message ? `${failure} ${message}` : failure;
		} else {
			message ??= "The provider reported that the job failed.";
		}
	}
	if ((!message || video) && job.expires_at !== null && job.expires_at <= now)
		message = `The provider's last reported ${video ? "video" : "image"} expiry has passed.`;
	const tracking = isReadPaused(note)
		? "paused"
		: isActive(job)
			? now < jobPollDeadline(job)
				? "automatic"
				: "manual"
			: "done";
	return {
		id: job.id,
		batchId: job.batch_id,
		slot: job.slot,
		attempt: job.attempt,
		taskId: job.task_id,
		skipped: job.skipped,
		throttled: !!job.throttle,
		retryPending:
			job.retry_state === "ready" ||
			job.retry_state === "settlement" ||
			job.retry_state === "watch",
		provider: job.provider,
		model: job.model,
		...(job.file_phase && { filePhase: job.file_phase }),
		operation: job.operation,
		state: job.skipped ? "unsent" : job.state,
		createdAt: job.created_at,
		updatedAt: job.updated_at ?? job.created_at,
		pollDeadline: jobPollDeadline(job),
		nextReadAt: job.next_read_at ?? (lookupPending ? job.created_at + 5_000 : null),
		submitAfter:
			(job.skipped === "cooldown" || (video && job.throttle)) &&
			job.retry_at !== null &&
			job.retry_at > now
				? job.retry_at
				: null,
		tracking,
		message,
		quote: JSON.parse(job.quote) as PriceEstimate,
		billing:
			storedBilling(job) ??
			(job.task_id && job.provider === "toapis" ? { status: "unknown" } : null),
		wallet:
			job.skipped || (job.batch_id && (job.slot !== 1 || job.attempt !== 1))
				? null
				: walletSummary(job),
		expiresAt: job.expires_at,
		canRefresh,
		canLookup: lookupPending && readable,
		progress: job.video_progress ?? null,
		video,
		library,
		retryable:
			canRefresh &&
			!expired &&
			!isReadPaused(job.pause_reason) &&
			!job.save_attempt &&
			(library === "failed" || library === "removed" || library === "unavailable"),
	};
}
