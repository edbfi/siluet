import { type CheckFetch, isRecord, readJson } from "../connection-check";

/**
 * ToAPIs' per-key model list, the inventory snapshot's only source.
 *
 * https://docs.toapis.com/docs/en/api-reference/chat/list-models (Markdown SHA-256
 * `79dcc852…`, scripts/media-catalog/sources/toapis-pages.json):
 * - `GET https://toapis.com/v1/models?type=text|chat|image|video|audio|all`, default `text`.
 *   Siluet reads only `type=<scope>` for the operation's output media, never the union.
 * - The envelope is `{success, object: "list", data: [{id, object: "model", created, owned_by,
 *   supported_endpoint_types}]}`.
 * - Results are "filtered dynamically based on token model restrictions, user group, enabled
 *   channels, and model pricing configuration". A listing is not evidence of entitlement,
 *   filtering compatibility or price.
 *
 * Unknowns: the page says nothing about billing or metering of this request, rate limits,
 * pagination or an error envelope. Siluet treats a body-less GET as non-billable, reads one page,
 * and maps 401 and 403 to a refused key as `errors` documents for the API. Mainland users are
 * pointed at `toapis.cn`, which Siluet does not read.
 */
export type ModelListResult =
	| { outcome: "succeeded"; models: string[] }
	/** The key was refused (401 or 403). */
	| { outcome: "rejected" }
	/** Any other failure after the request started: HTTP, redirect, timeout, parse, size, TLS or reset. */
	| { outcome: "unavailable" }
	/** The request never reached the host: DNS or connect failure, before any response. */
	| { outcome: "unreachable" };

// Bun's fetch rejects with these codes only before a connection exists. Any other code,
// including a reset, a TLS failure or a redirect refused by `redirect: "error"`, is a failure.
const connectStage = new Set([
	"ECONNREFUSED",
	"ConnectionRefused",
	"ENOTFOUND",
	"EAI_AGAIN",
	"EAI_NONAME",
	"ESERVFAIL",
	"ENETUNREACH",
	"EHOSTUNREACH",
]);

function unreachable(error: unknown) {
	const code = typeof error === "object" && error && "code" in error ? error.code : null;
	return typeof code === "string" && connectStage.has(code);
}

function listedIds(body: unknown): string[] | null {
	if (
		!isRecord(body) ||
		body.success !== true ||
		body.object !== "list" ||
		!Array.isArray(body.data)
	)
		return null;
	const ids: string[] = [];
	for (const model of body.data) {
		if (!isRecord(model) || typeof model.id !== "string" || !model.id) return null;
		ids.push(model.id);
	}
	return [...new Set(ids)].sort();
}

export const defaultModelListOrigin = "https://toapis.com";

export function readModelList(
	read: CheckFetch = fetch,
	{ origin = defaultModelListOrigin, timeoutMs = 5000 } = {},
) {
	return async (key: string, scope: "image" | "video"): Promise<ModelListResult> => {
		let response: Response;
		try {
			response = await read(`${origin}/v1/models?type=${scope}`, {
				method: "GET",
				headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
				redirect: "error",
				signal: AbortSignal.timeout(timeoutMs),
			});
		} catch (error) {
			return { outcome: unreachable(error) ? "unreachable" : "unavailable" };
		}
		if (!response.ok) {
			void response.body?.cancel().catch(() => {});
			return {
				outcome: response.status === 401 || response.status === 403 ? "rejected" : "unavailable",
			};
		}
		try {
			const models = listedIds(await readJson(response));
			return models ? { outcome: "succeeded", models } : { outcome: "unavailable" };
		} catch {
			return { outcome: "unavailable" };
		}
	};
}
