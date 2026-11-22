import { type CheckFetch, isRecord } from "../connection-check";
import {
	decimalText,
	imageResultUrl,
	isTaskId,
	type Rejection,
	type ReviewedImageRequest,
	requestImageJson,
	type Submission,
	type TaskBilling,
	type TaskObservation,
	type TaskState,
} from "../image-job";
import { queryLimit, submitThrottled } from "./rate-limits";

const endpoint = "https://toapis.com/v1/images/generations";

const states = new Map<unknown, TaskState>([
	["pending", "waiting"],
	["queued", "waiting"],
	["in_progress", "running"],
	["completed", "completed"],
	["failed", "failed"],
]);

// https://docs.toapis.com/docs/en/api-reference/errors
const errors = new Map<unknown, Rejection>([
	["invalid_request", "validation"],
	["invalid_request_error", "validation"],
	["invalid_params", "validation"],
	["InvalidParameter", "validation"],
	["invalid_parameter_error", "validation"],
	["invalid_value", "validation"],
	["invalid_json", "validation"],
	["invalid_image", "validation"],
	["invalid_image_file", "validation"],
	["invalid_private_assets", "validation"],
	["unknown_parameter", "validation"],
	["unsupported_value", "validation"],
	["provider_capability_not_supported", "validation"],
	["not_supported", "validation"],
	["access_denied", "authorization"],
	["authentication_error", "authorization"],
	["insufficient_user_quota", "quota"],
	["quota_not_enough", "quota"],
	["token_quota_not_enough", "quota"],
	["sensitive_words_detected", "filtering"],
	["prompt_blocked", "filtering"],
	["content_policy_violation", "filtering"],
	["content_filter", "filtering"],
	["content_filtered", "filtering"],
]);

function rejection(status: number, body: unknown) {
	if (status >= 500 || status === 408 || status === 429) return null;
	const error = isRecord(body) && isRecord(body.error) ? body.error : null;
	const code = error?.code;
	const noCode = code == null || code === "";
	const reason = errors.get(code) ?? (noCode ? errors.get(error?.type) : null);
	if (reason) return reason;
	if (noCode || code === status) {
		if (status === 401 || status === 403) return "authorization";
	}
	return null;
}

export function billing(value: unknown): TaskBilling {
	if (!isRecord(value) || (value.status !== "settled" && value.status !== "refunded"))
		return { status: "unknown" };
	const credits = decimalText(value.credits);
	const usd = decimalText(value.cost_usd);
	if (
		value.status === "refunded" &&
		((credits !== null && /[1-9]/.test(credits)) || (usd !== null && /[1-9]/.test(usd)))
	)
		return { status: "conflicting" };
	return credits === null || usd === null
		? { status: "unknown" }
		: { status: value.status, credits, usd };
}

export function expiry(value: unknown) {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= 8.64e12
		? value * 1000
		: null;
}

function oneImage(result: unknown) {
	if (
		!isRecord(result) ||
		(result.type !== undefined && result.type !== "image") ||
		!Array.isArray(result.data)
	)
		return null;
	const [image] = result.data;
	return result.data.length === 1 && isRecord(image) ? imageResultUrl(image.url) : null;
}

export function createToapisImage(read: CheckFetch = fetch) {
	return {
		// https://docs.toapis.com/docs/en/api-reference/images/seedream-5.5/generation
		async submit(key: string, request: ReviewedImageRequest): Promise<Submission> {
			if (request.url !== endpoint) return { kind: "unknown" };
			const { ok, status, body, retryAfter, category } = await requestImageJson(
				read,
				endpoint,
				key,
				request,
			);
			if (isRecord(body)) {
				if (Object.hasOwn(body, "id")) {
					return ok &&
						isTaskId(body.id) &&
						body.error == null &&
						(body.success === undefined || body.success === true)
						? { kind: "accepted", taskId: body.id }
						: { kind: "unknown" };
				}
				if (
					body.object === "generation.task" ||
					states.has(body.status) ||
					(body.success !== undefined && body.success !== false)
				)
					return { kind: "unknown" };
			}
			if (submitThrottled(status, category, body)) return { kind: "throttled", retryAfter };
			const reason = rejection(status, body);
			return reason ? { kind: "rejected", reason } : { kind: "unknown" };
		},
		// https://docs.toapis.com/docs/en/api-reference/tasks/image-status
		async status(key: string, taskId: string): Promise<TaskObservation> {
			if (!isTaskId(taskId)) return { kind: "paused", reason: "missing-task", retryAfter: null };
			const { ok, status, body, retryAfter, category, remaining, reset } = await requestImageJson(
				read,
				`${endpoint}/${taskId}`,
				key,
			);
			const quota = queryLimit(category, remaining, reset);
			const task = isRecord(body) ? body : null;
			const state = task?.id === taskId ? states.get(task.status) : undefined;
			const error = isRecord(task?.error) ? task.error : null;
			if (
				status === 401 ||
				status === 403 ||
				(ok &&
					state !== "failed" &&
					(error?.code === 401 ||
						error?.code === 403 ||
						rejection(status, body) === "authorization"))
			)
				return { kind: "paused", reason: "authorization", retryAfter, ...quota };
			if (
				status === 404 ||
				(ok &&
					state !== "failed" &&
					(error?.code === 404 ||
						error?.code === "task_not_found" ||
						error?.code === "task_not_exist"))
			)
				return { kind: "paused", reason: "missing-task", retryAfter, ...quota };
			if (!ok || !task) return { kind: "temporary", retryAfter, ...quota };
			if (error && state !== "failed") return { kind: "temporary", retryAfter, ...quota };
			const hasOutputs =
				isRecord(task.result) && Array.isArray(task.result.data) && task.result.data.length > 0;
			if (!state || (state === "failed" && hasOutputs))
				return { kind: "paused", reason: "unknown-status", retryAfter, ...quota };
			return {
				kind: "observed",
				state,
				failureReason:
					state === "failed" && error?.reason === "reference_media_unreadable"
						? "reference_media_unreadable"
						: null,
				...(state === "failed" &&
					(error?.reason === "service_busy" || error?.reason === "request_rate_limited") && {
						transientFailure: error.reason,
						settlementPending:
							task.billing == null || (isRecord(task.billing) && task.billing.status === "pending"),
					}),
				billing: billing(task.billing),
				resultUrl: state === "completed" ? oneImage(task.result) : null,
				expiresAt: state === "completed" ? expiry(task.expires_at) : null,
				retryAfter,
				...quota,
			};
		},
	};
}
