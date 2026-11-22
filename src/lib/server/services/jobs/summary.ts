import { reconcileWallet, type WalletScope } from "../../../shared/billing/wallet";
import type { PriceEstimate } from "../../../shared/pricing/estimate";
import type { ProviderId } from "../../../shared/providers/connections";
import {
	hasCorrelation,
	type ImageJob,
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
	galleryReason: ImageJob["gallery_reason"];
	state: JobState | "unsent";
	createdAt: number;
	updatedAt: number;
	pollDeadline: number;
	nextReadAt: number | null;
	tracking: "automatic" | "manual" | "paused" | "done";
	message: string | null;
	quote: PriceEstimate;
	billing: TaskBilling | null;
	wallet: JobWallet | null;
	expiresAt: number | null;
	canRefresh: boolean;
	canLookup: boolean;
	progress: number | null;
	canSave: boolean;
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
	"credential-changed": "Status and unsaved results require the original API key for this job.",
	temporary: "The provider status is temporarily unavailable.",
	"unsupported-video-result":
		"The provider returned an unsupported video result. Check provider history.",
	"result-unavailable":
		"The provider has no usable image link. Try again or check provider history.",
};

export function isActive(job: ImageJob) {
	return job.state === "waiting" || job.state === "running";
}

export function isReadPaused(note: StatusNote | null) {
	return note !== null && note !== "temporary" && note !== "result-unavailable";
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

export function summarizeJob(job: ImageJob, readable: boolean, now: number): JobSummary {
	const canRefresh = job.task_id !== null && readable;
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
		message = "No usable video result was available. Check provider history or retry Save.";
	if (job.state === "unknown") {
		if (note === "missing-task") message = "The provider could not find this task.";
		if (lookupPending && note === "unknown-status")
			message = "Task identity or status could not be verified.";
		const warning =
			"This attempt may still cost credits. Check provider history before authorizing another request.";
		message = message ? `${message} ${warning}` : warning;
	}
	if (job.skipped === "retry-evidence")
		message = "Not submitted. New task evidence ruled out this retry.";
	else if (job.skipped)
		message =
			job.skipped === "cooldown" && job.retry_at
				? `Not submitted. Provider cooldown until ${new Date(job.retry_at).toISOString()}. Review again before queuing.`
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
		operation: job.operation,
		galleryReason: job.gallery_reason,
		state: job.skipped ? "unsent" : job.state,
		createdAt: job.created_at,
		updatedAt: job.updated_at ?? job.created_at,
		pollDeadline: jobPollDeadline(job),
		nextReadAt: job.next_read_at ?? (lookupPending ? job.created_at + 5_000 : null),
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
		canSave:
			canRefresh &&
			job.state === "completed" &&
			(!video || (!isReadPaused(note) && (job.expires_at === null || job.expires_at > now))),
	};
}
