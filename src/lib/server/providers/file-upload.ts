import type { StageDescriptor } from "../../shared/image-studio/file-edit";
import { parseReferenceUrl } from "../../shared/image-studio/references";
import type { Rejection } from "./image-job";

export type UploadFile = Pick<StageDescriptor, "mime" | "size">;
export type UploadOutcome =
	| { kind: "unknown" }
	| { kind: "stored"; reason?: "expired-link" }
	| { kind: "ready"; url: string; expiresAt?: number }
	| { kind: "rejected"; reason: Rejection };
export const uncertainUpload = { kind: "unknown" } as const;
export function transient(value: unknown) {
	return typeof value === "number" && (value === 408 || value === 429 || value >= 500);
}
function expiry(value: unknown) {
	if (typeof value !== "string") return undefined;
	const match =
		/^(\d{4}-\d{2}-\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):?[0-5]\d)$/i.exec(
			value,
		);
	if (!match) return undefined;
	const day = Date.parse(`${match[1]}T00:00:00Z`);
	const time = Date.parse(value);
	return Number.isFinite(day) &&
		new Date(day).toISOString().startsWith(`${match[1]}T`) &&
		Number.isFinite(time)
		? time
		: undefined;
}
export function storedUpload(
	id: unknown,
	url: unknown,
	mime: unknown,
	size: unknown,
	expires: unknown,
	file: UploadFile,
): UploadOutcome {
	const expiresAt = expiry(expires);
	if (typeof id !== "string" || !id.trim()) return uncertainUpload;
	if (
		typeof url !== "string" ||
		url.length > 8192 ||
		url !== url.trim() ||
		!parseReferenceUrl(url) ||
		!/^https:\/\//i.test(url) ||
		new URL(url).port ||
		mime !== file.mime ||
		size !== file.size
	)
		return { kind: "stored" };
	if (expiresAt !== undefined && expiresAt <= Date.now())
		return { kind: "stored", reason: "expired-link" };
	return { kind: "ready", url, ...(expiresAt !== undefined && { expiresAt }) };
}
