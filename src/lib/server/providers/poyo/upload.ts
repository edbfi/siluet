import { isRecord } from "../connection-check";
import {
	storedUpload,
	transient,
	type UploadFile,
	type UploadOutcome,
	uncertainUpload,
} from "../file-upload";

// https://docs.poyo.ai/api-manual/file-series/upload-stream
export function interpretPoyoUpload(
	status: number,
	body: unknown,
	file: UploadFile,
): UploadOutcome {
	if (
		!isRecord(body) ||
		status < 200 ||
		status === 404 ||
		transient(status) ||
		transient(body.code)
	)
		return uncertainUpload;
	const { data, code, success } = body;
	if (success === true) {
		if (
			status >= 300 ||
			code !== 200 ||
			body.error != null ||
			body.detail != null ||
			!isRecord(data)
		)
			return uncertainUpload;
		return storedUpload(
			data.file_id,
			data.file_url,
			data.mime_type,
			data.file_size,
			data.expires_at,
			file,
		);
	}
	if (
		data != null ||
		(success !== undefined && success !== false) ||
		body.file_id != null ||
		body.file_url != null
	)
		return uncertainUpload;
	if (success === false && (status < 300 || status === code)) {
		if (code === 400) return { kind: "rejected", reason: "validation" };
		if (code === 401 || code === 403) return { kind: "rejected", reason: "authorization" };
		if (code === 402) return { kind: "rejected", reason: "quota" };
	}
	const detail = body.detail;
	const documentedDetail =
		typeof detail === "string"
			? detail.trim().length > 0
			: Array.isArray(detail) &&
				detail.length > 0 &&
				detail.every(
					(entry) => isRecord(entry) && typeof entry.msg === "string" && Array.isArray(entry.loc),
				);
	if (code == null && documentedDetail) {
		if ([400, 413, 422].includes(status)) return { kind: "rejected", reason: "validation" };
		if ([401, 403].includes(status)) return { kind: "rejected", reason: "authorization" };
	}
	return uncertainUpload;
}
