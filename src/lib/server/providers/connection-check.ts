export type ConnectionCheckResult =
	| { outcome: "accepted"; seedream: boolean }
	| { outcome: "rejected" | "unavailable" };

export type ConnectionCheck = (key: string) => Promise<ConnectionCheckResult>;
export type CheckFetch = (url: string, init: RequestInit) => Promise<Response>;

const maxResponseBytes = 2 * 1024 * 1024;

async function readJson(response: Response): Promise<unknown> {
	if (!response.body) return null;
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let bytes = 0;
	let text = "";
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) return JSON.parse(text + decoder.decode());
			bytes += value.byteLength;
			if (bytes > maxResponseBytes) {
				void reader.cancel().catch(() => {});
				return null;
			}
			text += decoder.decode(value, { stream: true });
		}
	} finally {
		reader.releaseLock();
	}
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
	value !== null && typeof value === "object" && !Array.isArray(value);

type FailedCheck = Extract<ConnectionCheckResult, { outcome: "rejected" | "unavailable" }>;
export function createConnectionCheck<T extends { outcome: "accepted" }>(
	url: string,
	interpret: (value: unknown) => T | FailedCheck,
	read: CheckFetch,
): (key: string) => Promise<T | FailedCheck> {
	return async (key) => {
		try {
			const response = await read(url, {
				method: "GET",
				headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
				redirect: "error",
				signal: AbortSignal.timeout(5000),
			});
			if (response.ok) return interpret(await readJson(response));
			void response.body?.cancel().catch(() => {});
			return {
				outcome: response.status === 401 || response.status === 403 ? "rejected" : "unavailable",
			};
		} catch {
			return { outcome: "unavailable" };
		}
	};
}
