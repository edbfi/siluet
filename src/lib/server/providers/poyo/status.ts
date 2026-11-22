import { type CheckFetch, isRecord } from "../connection-check";
import {
	decimalText,
	imageResultUrl,
	isTaskId,
	requestImageJson,
	type TaskObservation,
	type TaskState,
} from "../image-job";

// Image and video tasks share one status route and envelope.
// https://docs.poyo.ai/api-manual/task-management/status
// https://docs.poyo.ai/api-manual/task-management/video-status.md
const statusUrl = "https://api.poyo.ai/api/generate/status";
const states = new Map<unknown, TaskState>([
	["not_started", "waiting"],
	["running", "running"],
	["finished", "completed"],
	["failed", "failed"],
]);

export function poyoAmount(value: unknown) {
	return typeof value === "number" && Number.isFinite(value) && value >= 0
		? decimalText(
				value.toLocaleString("en-US", { useGrouping: false, maximumSignificantDigits: 21 }),
			)
		: null;
}

export type PoyoMedia = "image" | "video";

// An image result is the one image among the files. A video result is the only file.
function resultUrl(files: unknown, media: PoyoMedia) {
	if (!Array.isArray(files) || (media === "video" && files.length !== 1)) return null;
	const entries = files.filter((entry) => isRecord(entry) && entry.file_type === media);
	return entries.length === 1 ? imageResultUrl(entries[0].file_url) : null;
}

function unsupportedVideo(files: unknown) {
	return (
		files != null &&
		(!Array.isArray(files) ||
			files.length > 1 ||
			(files.length === 1 &&
				(!isRecord(files[0]) || (files[0].file_type != null && files[0].file_type !== "video"))))
	);
}

export async function readPoyoStatus(
	read: CheckFetch,
	key: string,
	taskId: string,
	media: PoyoMedia,
): Promise<TaskObservation> {
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
	if (!ok || !isRecord(body) || code !== 200 || body.error != null || !isRecord(body.data))
		return { kind: "temporary", retryAfter };
	const { data } = body;
	const state = data.task_id === taskId ? states.get(data.status) : undefined;
	if (!state) return { kind: "paused", reason: "unknown-status", retryAfter };
	const credits = poyoAmount(data.credits_amount);
	const completed = state === "completed";
	return {
		kind: "observed",
		state,
		failureReason: null,
		...(media === "video" &&
			completed &&
			unsupportedVideo(data.files) && { unsupportedVideoResult: true as const }),
		billing: credits === null ? null : { status: "reported", credits },
		resultUrl: completed ? resultUrl(data.files, media) : null,
		expiresAt: null,
		retryAfter,
	};
}

/** An error envelope with no task evidence. */
export function isPoyoErrorEnvelope(
	body: unknown,
): body is { code: number; error: { type: string } } {
	return (
		isRecord(body) &&
		Number.isInteger(body.code) &&
		isRecord(body.error) &&
		typeof body.error.type === "string" &&
		Object.keys(body.error).every((key) => ["type", "message", "code", "param"].includes(key)) &&
		Object.keys(body).every((key) => ["code", "error", "message", "data"].includes(key)) &&
		(body.data == null || (isRecord(body.data) && Object.keys(body.data).length === 0))
	);
}

/** The exact Poyo limiter reply that closes the submission gate. */
export function isPoyoSubmitLimit(status: number, body: unknown) {
	return (
		status === 429 &&
		isPoyoErrorEnvelope(body) &&
		body.code === 429 &&
		body.error.type === "rate_limit_error"
	);
}
