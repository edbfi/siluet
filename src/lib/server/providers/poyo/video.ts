import type { PoyoVideoBody } from "../../../shared/video-studio/poyo-video";
import { type CheckFetch, isRecord } from "../connection-check";
import { isTaskId, type Rejection, requestImageJson, type Submission } from "../image-job";
import { isPoyoErrorEnvelope, isPoyoSubmitLimit, readPoyoStatus } from "./status";

const submitUrl = "https://api.poyo.ai/api/generate/submit";

// A definite rejection is an error envelope with one of these business codes and types.
const reasons = new Map<string, Rejection>([
	["400:validation_error", "validation"],
	["400:invalid_request_error", "validation"],
	["400:content_too_long_error", "validation"],
	["400:file_format_error", "validation"],
	["400:content_moderation_error", "filtering"],
	["401:authentication_error", "authorization"],
	["402:insufficient_credits_error", "quota"],
	["403:permission_denied_error", "permission"],
]);

// The Poyo video family: one Bearer JSON {model, input} submission per reviewed request.
// https://docs.poyo.ai/api-manual/video-series/h3-max.md
// https://docs.poyo.ai/api-manual/error-codes
export function createPoyoVideo(read: CheckFetch = fetch) {
	return {
		async submit(key: string, body: PoyoVideoBody): Promise<Submission> {
			const response = await requestImageJson(read, submitUrl, key, { method: "POST", body });
			const value = response.body;
			if (isPoyoSubmitLimit(response.status, value))
				return { kind: "throttled", retryAfter: response.retryAfter };
			if (!isRecord(value)) return { kind: "unknown" };
			if (
				response.ok &&
				value.code === 200 &&
				value.error == null &&
				isRecord(value.data) &&
				value.data.error == null &&
				(value.data.error_message == null || value.data.error_message === "") &&
				isTaskId(value.data.task_id)
			)
				return { kind: "accepted", taskId: value.data.task_id };
			if (
				!isPoyoErrorEnvelope(value) ||
				(response.status !== 200 && response.status !== value.code)
			)
				return { kind: "unknown" };
			const reason = reasons.get(`${value.code}:${value.error.type}`);
			return reason ? { kind: "rejected", reason } : { kind: "unknown" };
		},
		status: (key: string, taskId: string) => readPoyoStatus(read, key, taskId, "video"),
	};
}
