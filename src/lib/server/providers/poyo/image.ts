import { type CheckFetch, isRecord } from "../connection-check";
import {
	decimalText,
	imageResultUrl,
	isTaskId,
	type Rejection,
	type ReviewedImageRequest,
	requestImageJson,
	type Submission,
	type TaskObservation,
	type TaskState,
} from "../image-job";

const submitUrl = "https://api.poyo.ai/api/generate/submit";
const statusUrl = "https://api.poyo.ai/api/generate/status";
const balanceUrl = "https://api.poyo.ai/api/user/balance";

const states = new Map<unknown, TaskState>([
	["not_started", "waiting"],
	["running", "running"],
	["finished", "completed"],
	["failed", "failed"],
]);

function amount(value: unknown) {
	return typeof value === "number" && Number.isFinite(value) && value >= 0
		? decimalText(
				value.toLocaleString("en-US", { useGrouping: false, maximumSignificantDigits: 21 }),
			)
		: null;
}

function oneImage(files: unknown) {
	if (!Array.isArray(files)) return null;
	const images = files.filter((entry) => isRecord(entry) && entry.file_type === "image");
	return images.length === 1 ? imageResultUrl(images[0].file_url) : null;
}

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
	if (
		(code === 401 && error === "authentication_error") ||
		(code === 403 && error === "permission_denied_error") ||
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
			if (
				status === 429 &&
				isRecord(body) &&
				body.code === 429 &&
				isRecord(body.error) &&
				body.error.type === "rate_limit_error" &&
				Object.keys(body.error).every((key) =>
					["type", "message", "code", "param"].includes(key),
				) &&
				Object.keys(body).every((key) => ["code", "error", "message", "data"].includes(key)) &&
				(body.data == null || (isRecord(body.data) && !Object.keys(body.data).length))
			)
				return { kind: "throttled", retryAfter };
			const reason = rejection(status, body);
			return reason ? { kind: "rejected", reason } : { kind: "unknown" };
		},
		// https://docs.poyo.ai/api-manual/task-management/status
		async status(key: string, taskId: string): Promise<TaskObservation> {
			if (!isTaskId(taskId)) return { kind: "paused", reason: "missing-task", retryAfter: null };
			const { ok, status, body, retryAfter } = await requestImageJson(
				read,
				`${statusUrl}/${taskId}`,
				key,
			);
			const code = isRecord(body) ? body.code : null;
			if (status === 401 || status === 403 || (ok && (code === 401 || code === 403)))
				return { kind: "paused", reason: "authorization", retryAfter };
			if (status === 404 || (ok && code === 404))
				return { kind: "paused", reason: "missing-task", retryAfter };
			if (!ok || !isRecord(body) || code !== 200 || !isRecord(body.data))
				return { kind: "temporary", retryAfter };
			const { data } = body;
			const state = data.task_id === taskId ? states.get(data.status) : undefined;
			if (!state) return { kind: "paused", reason: "unknown-status", retryAfter };
			const credits = amount(data.credits_amount);
			return {
				kind: "observed",
				state,
				failureReason: null,
				billing: credits === null ? null : { status: "reported", credits },
				resultUrl: state === "completed" ? oneImage(data.files) : null,
				expiresAt: null,
				retryAfter,
			};
		},
		// https://docs.poyo.ai/api-manual/account-management/user-balance
		async balance(key: string): Promise<string | null> {
			const { ok, body } = await requestImageJson(read, balanceUrl, key);
			return ok && isRecord(body) && body.code === 200 && isRecord(body.data)
				? amount(body.data.credits_amount)
				: null;
		},
	};
}
