import { isRecord } from "../connection-check";

export function submitThrottled(status: number, category: string | null, body: unknown) {
	return (
		status === 429 &&
		category === "async_submit" &&
		isRecord(body) &&
		(body.success === undefined || body.success === false) &&
		isRecord(body.error) &&
		body.error.code === "rate_limit_exceeded" &&
		Object.keys(body.error).every((key) => ["type", "message", "code", "param"].includes(key)) &&
		Object.keys(body).every((key) => ["error", "message", "success"].includes(key))
	);
}

// ToAPIs lists Reset without units. Only a ten-digit value on a depleted query
// bucket is interpreted as Unix seconds. This is a local fixture assumption.
export function queryLimit(
	category: string | null,
	remaining: string | null,
	reset: string | null,
) {
	return category === "async_query" && remaining === "0" && reset && /^\d{10}$/.test(reset)
		? { queryAfter: Number(reset) * 1000 }
		: {};
}
