import {
	type CheckFetch,
	type ConnectionCheckResult,
	createConnectionCheck,
	isRecord,
} from "../connection-check";

function interpretBalance(body: unknown): ConnectionCheckResult {
	if (!isRecord(body)) return { outcome: "unavailable" };
	if (body.code === 401 || body.code === 403) return { outcome: "rejected" };
	if (
		body.code !== 200 ||
		!isRecord(body.data) ||
		typeof body.data.credits_amount !== "number" ||
		!Number.isFinite(body.data.credits_amount)
	)
		return { outcome: "unavailable" };
	return { outcome: "accepted", seedream: true };
}

export function checkPoyoConnection(read: CheckFetch = fetch) {
	return createConnectionCheck("https://api.poyo.ai/api/user/balance", interpretBalance, read);
}
