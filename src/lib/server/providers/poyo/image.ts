import { type CheckFetch, isRecord } from "../connection-check";
import {
	isTaskId,
	type Rejection,
	type ReviewedImageRequest,
	requestImageJson,
	type Submission,
} from "../image-job";
import { isPoyoSubmitLimit, poyoAmount, readPoyoStatus } from "./status";

const submitUrl = "https://api.poyo.ai/api/generate/submit";
const balanceUrl = "https://api.poyo.ai/api/user/balance";

function rejection(status: number, body: unknown): Rejection | null {
	if (status >= 500 || status === 408 || status === 429) return null;
	const code = isRecord(body) ? body.code : null;
	if (status !== 200 && code != null && status !== code) return null;
	if (isRecord(body) && isRecord(body.data) && Object.hasOwn(body.data, "status")) return null;
	const error = isRecord(body) && isRecord(body.error) ? body.error.type : null;
	if (
		code === 400 &&
		(error === "validation_error" ||
			error === "invalid_request_error" ||
			error === "content_too_long_error" ||
			error === "file_format_error")
	)
		return "validation";
	if (code === 400 && error === "content_moderation_error") return "filtering";
	const httpRejection = error == null && (code == null || code === status);
	if ((code === 402 && error === "insufficient_credits_error") || (httpRejection && status === 402))
		return "quota";
	// A per-job refusal of this model for this key; the key itself stays valid (spec).
	if (code === 403 && error === "permission_denied_error") return "permission";
	if (
		(code === 401 && error === "authentication_error") ||
		(httpRejection && (status === 401 || status === 403))
	)
		return "authorization";
	return null;
}

export function createPoyoImage(read: CheckFetch = fetch) {
	return {
		// https://docs.poyo.ai/api-manual/image-series/seedream-5-5
		// https://docs.poyo.ai/api-manual/image-series/z-image
		// https://docs.poyo.ai/api-manual/error-codes
		async submit(key: string, request: ReviewedImageRequest): Promise<Submission> {
			if (request.url !== submitUrl) return { kind: "unknown" };
			const { ok, status, body, retryAfter } = await requestImageJson(
				read,
				submitUrl,
				key,
				request,
			);
			if (isRecord(body) && isRecord(body.data) && Object.hasOwn(body.data, "task_id"))
				return ok && body.code === 200 && body.error == null && isTaskId(body.data.task_id)
					? { kind: "accepted", taskId: body.data.task_id }
					: { kind: "unknown" };
			if (isPoyoSubmitLimit(status, body)) return { kind: "throttled", retryAfter };
			const reason = rejection(status, body);
			return reason ? { kind: "rejected", reason } : { kind: "unknown" };
		},
		status: (key: string, taskId: string) => readPoyoStatus(read, key, taskId, "image"),
		// https://docs.poyo.ai/api-manual/account-management/user-balance
		async balance(key: string): Promise<string | null> {
			const { ok, body } = await requestImageJson(read, balanceUrl, key);
			return ok && isRecord(body) && body.code === 200 && isRecord(body.data)
				? poyoAmount(body.data.credits_amount)
				: null;
		},
	};
}
