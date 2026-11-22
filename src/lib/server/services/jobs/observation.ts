import type { ImageJob, StatusNote } from "../../db/image-job-store";
import { retryTime } from "../../db/provider-gate";
import type { TaskBilling, TaskFailureReason, TaskObservation } from "../../providers/image-job";
import { retryDelay } from "../queue/submit-gate";
import { mergeBilling } from "./settlement";
import { isActive, isReadPaused, storedBilling } from "./summary";

function automaticRetryState(
	job: ImageJob,
	observation: TaskObservation,
	billing: TaskBilling | null,
) {
	if (!job.retry_state || job.retry_state === "done") return job.retry_state;
	if (
		job.completion_seen ||
		observation.kind === "paused" ||
		billing?.status === "settled" ||
		billing?.status === "conflicting"
	)
		return "done";
	if (observation.kind !== "observed") return job.retry_state;
	if (
		(job.retry_state !== "watch" && observation.state !== "failed") ||
		observation.state === "completed" ||
		observation.billing?.status === "settled" ||
		observation.billing?.status === "conflicting"
	)
		return "done";
	if (observation.state !== "failed") return job.retry_state;
	if (!observation.transientFailure) return "done";
	if (observation.billing?.status === "refunded") return "ready";
	return observation.settlementPending ? "settlement" : "done";
}

// Only the observer that reserved an automatic read may alter this evidence.
export function retryEvidence(
	job: ImageJob,
	observation: TaskObservation,
	billing: TaskBilling | null,
	finished: number,
	random: () => number,
): { state: ImageJob["retry_state"]; at: number | null } {
	const state = automaticRetryState(job, observation, billing);
	if (state !== "ready") return { state, at: null };
	if (job.retry_state === "ready") return { state, at: job.retry_at };
	const at = Math.max(
		finished + retryDelay(job.attempt ?? 1, random),
		retryTime(observation.retryAfter, finished),
	);
	return { state, at };
}

export function statusUpdate(
	job: ImageJob,
	observation: TaskObservation,
	now: number,
	interval: number,
) {
	const failures = observation.kind === "temporary" ? Math.min(job.read_failures + 1, 8) : 0;
	const delay = Math.min(60_000, interval * 2 ** failures);
	let note: StatusNote | null = null;
	let state = job.state;
	let failureReason: TaskFailureReason | null = null;
	let billing = storedBilling(job);
	let expiresAt = job.expires_at;
	let resultUrl: string | null = null;

	if (observation.kind === "paused") note = observation.reason;
	if (observation.kind === "temporary")
		note = isReadPaused(job.pause_reason) ? job.pause_reason : "temporary";
	if (observation.kind === "observed") {
		const terminalConflict =
			job.provider === "toapis" &&
			((job.state === "completed" && observation.state === "failed") ||
				(job.state === "failed" && observation.state === "completed"));
		const validTransition =
			isActive(job) ||
			(job.business_id && job.state === "unknown") ||
			job.state === observation.state;
		const merged = mergeBilling(billing, observation.billing);
		if (terminalConflict) billing = { status: "conflicting" };
		else if (validTransition || merged?.status === "conflicting") billing = merged;

		// A completed batch result is still available to save even if its charge is disputed.
		if (
			validTransition ||
			(terminalConflict && job.batch_id && observation.state === "completed")
		) {
			state = observation.state;
			failureReason = observation.failureReason;
			expiresAt = observation.expiresAt ?? job.expires_at;
			if (state === "completed") {
				resultUrl = expiresAt !== null && expiresAt <= now ? null : observation.resultUrl;
				if (!resultUrl)
					note = observation.unsupportedVideoResult
						? "unsupported-video-result"
						: "result-unavailable";
			}
		} else {
			note = "unknown-status";
		}
	}

	return {
		update: {
			completedObservation: observation.kind === "observed" && observation.state === "completed",
			state,
			billing,
			expiresAt,
			note,
			failureReason,
			transientFailure:
				observation.kind === "observed" && state === "failed"
					? (observation.transientFailure ?? null)
					: null,
			failures,
			nextReadAt:
				observation.kind === "observed" && !job.business_id
					? now + delay
					: Math.max(now + delay, retryTime(observation.retryAfter, now)),
		},
		resultUrl,
	};
}
