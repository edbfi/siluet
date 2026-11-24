import { seedanceOperation } from "../../../shared/media-catalog/registry";
import type { SeedanceBody } from "../../../shared/video-studio/seedance";
import { type CheckFetch, isRecord } from "../connection-check";
import {
	decimalText,
	imageResultUrl,
	isTaskId,
	requestImageJson,
	type Submission,
	type TaskBilling,
	type TaskObservation,
	type TaskState,
} from "../image-job";
import { expiry } from "./image";
import { queryLimit, submitThrottled } from "./rate-limits";

const endpoint = "https://toapis.com/v1/videos/generations";
const states = new Map<unknown, TaskState>([
	["queued", "waiting"],
	["in_progress", "running"],
	["completed", "completed"],
	["failed", "failed"],
]);
type Observation = TaskObservation & {
	taskId?: string;
	progress?: number | null;
	fallback?: string | null;
};
function task(value: unknown, business: string): (Record<string, unknown> & { id: string }) | null {
	return isRecord(value) &&
		value.object === "generation.task" &&
		value.model === seedanceOperation.key.model &&
		isTaskId(value.id) &&
		(!("success" in value) || value.success === true) &&
		(!("client_business_id" in value) || value.client_business_id === business)
		? { ...value, id: value.id }
		: null;
}
function videoBilling(value: unknown): TaskBilling {
	if (isRecord(value) && value.status === "pending") return { status: "pending" };
	if (!isRecord(value) || (value.status !== "settled" && value.status !== "refunded"))
		return { status: "unknown" };
	const amount: TaskBilling = {
		status: value.status,
		credits: decimalText(value.credits),
		usd: decimalText(value.cost_usd),
	};
	if (amount.credits === null && amount.usd === null) return { status: "unknown" };
	if (
		amount.status === "refunded" &&
		![amount.credits, amount.usd].every((n) => n !== null && /^0(?:\.0+)?$/.test(n))
	)
		return { status: "unknown" };
	return amount;
}
function refusal(status: number, value: unknown, media: boolean): Submission {
	if (
		!isRecord(value) ||
		!isRecord(value.error) ||
		Object.keys(value).some((k) => !["error", "success", "request_id"].includes(k)) ||
		Object.keys(value.error).some((k) => !["code", "type", "message", "param"].includes(k)) ||
		[value.error.message, value.error.param, value.request_id].some(
			(field) => field != null && typeof field !== "string",
		) ||
		("success" in value && value.success !== false)
	)
		return { kind: "unknown" };
	const { code, type } = value.error;
	if (
		status === 400 &&
		(type === undefined ||
			type === "toapis_error" ||
			type === "invalid_request_error" ||
			type === code)
	) {
		// A frame or source URL refused before a task exists; text-to-video sends no media, so it
		// stays uncertain.
		if (media && code === "invalid_private_assets")
			return { kind: "rejected", reason: "media-input" };
		if (code === "invalid_request" || code === "unsupported_value")
			return { kind: "rejected", reason: "validation" };
		if (code === "content_policy_violation") return { kind: "rejected", reason: "filtering" };
	}
	const authCodes: unknown[] = [
		undefined,
		null,
		"",
		"access_denied",
		"authentication_error",
		status,
	];
	if (
		(status === 401 || status === 403) &&
		authCodes.includes(code) &&
		(type === "authentication_error" ||
			type === "access_denied" ||
			((type === undefined || type === "toapis_error") &&
				(code === "access_denied" || code === "authentication_error")))
	)
		return { kind: "rejected", reason: "authorization" };
	return { kind: "unknown" };
}
// https://docs.toapis.com/docs/en/api-reference/videos/seedance-2-5/generation
// https://docs.toapis.com/docs/en/api-reference/tasks/video-status
export function createToapisVideo(read: CheckFetch = fetch) {
	return {
		async submit(key: string, body: SeedanceBody, business: string): Promise<Submission> {
			const response = await requestImageJson(read, endpoint, key, {
				method: "POST",
				body: { ...body, client_business_id: business },
			});
			const result = task(response.body, business);
			if (response.ok)
				return result && result.error == null
					? { kind: "accepted", taskId: result.id }
					: { kind: "unknown" };
			if (submitThrottled(response.status, response.category, response.body))
				return { kind: "throttled", retryAfter: response.retryAfter };
			return refusal(
				response.status,
				response.body,
				"image_with_roles" in body || "video_with_roles" in body,
			);
		},
		async status(key: string, business: string, taskId: string | null): Promise<Observation> {
			const response = await requestImageJson(
				read,
				`${endpoint}/${encodeURIComponent(taskId ?? business)}`,
				key,
			);
			const limits = {
				retryAfter: response.retryAfter,
				...queryLimit(response.category, response.remaining, response.reset),
			};
			if (response.status === 401 || response.status === 403)
				return { kind: "paused", reason: "authorization", ...limits };
			if (response.status === 404) return { kind: "paused", reason: "missing-task", ...limits };
			if (!response.ok) return { kind: "temporary", ...limits };
			const result = task(response.body, business);
			const state = result && states.get(result.status);
			if (
				!result ||
				!state ||
				(taskId ? result.id !== taskId : result.client_business_id !== business) ||
				(state !== "failed" && result.error != null)
			)
				return { kind: "paused", reason: "unknown-status", ...limits };
			const media = result.result;
			const unsupportedVideoResult =
				state === "completed" &&
				media != null &&
				(!isRecord(media) ||
					(media.type != null && media.type !== "video") ||
					(media.data != null &&
						(!Array.isArray(media.data) ||
							media.data.length > 1 ||
							(media.data.length === 1 && !isRecord(media.data[0])))));
			const item =
				state === "completed" &&
				isRecord(media) &&
				media.type === "video" &&
				Array.isArray(media.data) &&
				media.data.length === 1
					? media.data[0]
					: null;
			return {
				kind: "observed",
				taskId: result.id,
				...(unsupportedVideoResult && { unsupportedVideoResult: true as const }),
				state,
				progress:
					typeof result.progress === "number" &&
					Number.isInteger(result.progress) &&
					result.progress >= 0 &&
					result.progress <= 100
						? result.progress
						: null,
				billing: videoBilling(result.billing),
				// Only an allowlisted reason on a verified failure is kept; messages and codes are dropped.
				failureReason:
					state === "failed" &&
					isRecord(result.error) &&
					result.error.reason === "reference_media_unreadable"
						? "reference_media_unreadable"
						: null,
				expiresAt: expiry(result.expires_at),
				resultUrl: isRecord(item) ? imageResultUrl(item.url) : null,
				fallback: isRecord(item) ? imageResultUrl(item.fallback_url) : null,
				...limits,
			};
		},
	};
}
