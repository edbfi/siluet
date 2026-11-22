import { reconcileWallet, type WalletScope } from "../../../shared/billing/wallet";
import type { PriceEstimate } from "../../../shared/pricing/estimate";
import type { ProviderId } from "../../../shared/providers/connections";
import type { ImageJob, JobState, StatusNote } from "../../db/image-job-store";
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
	canSave: boolean;
};

const rejections: Record<Rejection, string> = {
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
	if (billing.status === "settled" || billing.status === "refunded") {
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
	const note = job.task_id && !readable ? "credential-changed" : job.pause_reason;
	let message = note ? statusNotes[note] : null;
	if (job.state === "unknown")
		message =
			"This attempt may still cost credits. Check provider history before authorizing another request.";
	if (job.skipped === "retry-evidence")
		message = "Not submitted. New task evidence ruled out this retry.";
	else if (job.skipped)
		message =
			job.skipped === "cooldown" && job.retry_at
				? `Not submitted. Provider cooldown until ${new Date(job.retry_at).toISOString()}. Review again before queuing.`
				: "Not submitted. The dispatch window closed before sending.";
	else if (job.throttle && job.batch_id) message = "Not admitted · throttled";
	if (job.rejection) message = rejections[job.rejection];
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
	if (!message && job.expires_at !== null && job.expires_at <= now)
		message = "The provider's last reported image expiry has passed.";
	const tracking = isReadPaused(note)
		? "paused"
		: isActive(job)
			? now < job.poll_deadline
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
		pollDeadline: job.poll_deadline,
		nextReadAt: job.next_read_at,
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
		canSave: canRefresh && job.state === "completed",
	};
}
