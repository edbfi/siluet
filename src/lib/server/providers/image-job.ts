import type { buildSeedreamRequest } from "../../shared/image-studio/seedream";
import type { buildZImageRequest } from "../../shared/image-studio/z-image";
import type { CheckFetch } from "./connection-check";

export type ReviewedImageRequest = ReturnType<
	typeof buildSeedreamRequest | typeof buildZImageRequest
>;

export type Rejection = "validation" | "authorization" | "quota" | "filtering";

export type Submission =
	| { kind: "accepted"; taskId: string }
	| { kind: "rejected"; reason: Rejection }
	| { kind: "unknown" };

export type TaskState = "waiting" | "running" | "completed" | "failed";
export type TaskFailureReason = "reference_media_unreadable";
export type StatusPause = "authorization" | "missing-task" | "unknown-status";
export type TaskBilling =
	| { status: "reported"; credits: string }
	| { status: "settled" | "refunded"; credits: string | null; usd: string | null }
	| { status: "unknown" };

export type TaskObservation = { retryAfter: string | null } & (
	| {
			kind: "observed";
			state: TaskState;
			failureReason: TaskFailureReason | null;
			billing: TaskBilling | null;
			resultUrl: string | null;
			expiresAt: number | null;
	  }
	| { kind: "paused"; reason: StatusPause }
	| { kind: "temporary" }
);

export const statusTimeoutMs = 5_000;
const maxResponseBytes = 256 * 1024;

async function boundedJson(response: Response): Promise<unknown> {
	if (!response.body) return null;
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let size = 0;
	let json = "";
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) return JSON.parse(json + decoder.decode());
			size += value.byteLength;
			if (size > maxResponseBytes) {
				void reader.cancel().catch(() => {});
				return null;
			}
			json += decoder.decode(value, { stream: true });
		}
	} finally {
		reader.releaseLock();
	}
}

export async function requestImageJson(
	read: CheckFetch,
	url: string,
	key: string,
	request?: ReviewedImageRequest,
) {
	try {
		const headers = new Headers({ Authorization: `Bearer ${key}`, Accept: "application/json" });
		if (request) headers.set("Content-Type", "application/json");
		const response = await read(url, {
			method: request?.method ?? "GET",
			headers,
			...(request && { body: JSON.stringify(request.body) }),
			redirect: "error",
			signal: AbortSignal.timeout(request ? 30_000 : statusTimeoutMs),
		});
		return {
			ok: response.ok,
			status: response.status,
			retryAfter: response.headers.get("Retry-After"),
			body: await boundedJson(response).catch((): null => null),
		};
	} catch {
		return { ok: false, status: 0, retryAfter: null, body: null };
	}
}

export function isTaskId(value: unknown): value is string {
	return typeof value === "string" && /^[A-Za-z0-9_-]{1,256}$/.test(value);
}

export function decimalText(value: unknown): string | null {
	return typeof value === "string" && /^(0|[1-9]\d{0,127})(\.\d{1,128})?$/.test(value)
		? value
		: null;
}

export function imageResultUrl(value: unknown): string | null {
	if (typeof value !== "string" || value.length > 8_192) return null;
	try {
		const url = new URL(value);
		return url.protocol === "https:" && !url.username && !url.password ? value : null;
	} catch {
		return null;
	}
}
