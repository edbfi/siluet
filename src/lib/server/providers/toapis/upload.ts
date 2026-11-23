import { isRecord } from "../connection-check";
import {
	storedUpload,
	transient,
	type UploadFile,
	type UploadOutcome,
	uncertainUpload,
} from "../file-upload";

// https://docs.toapis.com/docs/en/api-reference/uploads/images
export function interpretToapisUpload(
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
	const { data, success } = body;
	const error = isRecord(body.error) ? body.error : null;
	const code = error?.code ?? body.code ?? body.error;
	if (transient(code) || [code, error?.type, body.message].includes("read_request_body_failed"))
		return uncertainUpload;
	if (success === true) {
		if (
			status >= 300 ||
			body.error != null ||
			(body.code != null && body.code !== 200) ||
			!isRecord(data)
		)
			return uncertainUpload;
		return storedUpload(data.id, data.url, data.mime_type, data.size, data.expires_at, file);
	}
	if (
		data != null ||
		body.id != null ||
		body.url != null ||
		(success !== undefined && success !== false)
	)
		return uncertainUpload;
	if (status === 400 && success === false && !code)
		return { kind: "rejected", reason: "validation" };
	if (
		status >= 400 &&
		["invalid_image", "invalid_image_file", "invalid_parameter_error", "invalid_value"].includes(
			String(code),
		)
	)
		return { kind: "rejected", reason: "validation" };
	if (
		status >= 400 &&
		["insufficient_user_quota", "quota_not_enough", "token_quota_not_enough"].includes(String(code))
	)
		return { kind: "rejected", reason: "quota" };
	if (
		(status === 401 || status === 403) &&
		(!code || code === status || code === "authentication_error" || code === "access_denied")
	)
		return { kind: "rejected", reason: "authorization" };
	return uncertainUpload;
}
