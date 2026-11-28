// Queue requests for derived Poyo.ai text-to-image rows (catalog engine spec, "Claims and
// replay"). Review resolves the row in the current projection. A submit is parsed structurally
// and never looks the row up: its signature is checked first, then a claimed Review replays
// from storage, and only a new claim resolves the row and re-validates the exact body.
import {
	buildDerivedRequest,
	type DerivedDraft,
	validateDerivedDraft,
} from "../../../shared/image-studio/derived";
import { queueRowFor } from "../../../shared/media-catalog/image-queue";
import type { QueueKey, QueueRow } from "../../../shared/media-catalog/queue-row";
import { resolveOperationKey } from "../../../shared/media-catalog/registry";
import { reviewedRules } from "../../../shared/media-catalog/rules";
import { type RowSchemas, validateBody } from "../../../shared/media-catalog/schema";
import { poyoRateKey } from "../../../shared/pricing/poyo-feed";
import { queueSchemas } from "../../providers/poyo/queue-schemas";

export type DerivedRequest = ReturnType<typeof buildDerivedRequest>;

/** A derived Queue request: the draft exactly as submitted, and its row once resolved. */
export type DerivedLiveRequest = {
	readonly derived: true;
	readonly count: 1;
	readonly retryLimit: 0;
	readonly key: QueueKey;
	draft: DerivedDraft;
	readonly acceptUnknown: boolean;
	readonly token: unknown;
	/** Resolved at Review; a submit resolves it only after the replay lookup misses. */
	readonly row?: QueueRow;
	readonly request?: DerivedRequest;
};

/** Where a derived row and its pinned schemas come from: the current projection by default. */
export type DerivedRows = {
	readonly row: (key: QueueKey) => QueueRow | undefined;
	readonly schemas: (key: QueueKey) => RowSchemas | undefined;
};
export const derivedRows: DerivedRows = { row: queueRowFor, schemas: queueSchemas };

const requestKeys = ["draft", "operationKey", "count", "retryLimit", "acceptUnknown", "token"];
const draftKeys = ["model", "operation", "prompt", "options"];
const keyKeys = ["provider", "model", "route", "operation"];
// Far above any documented prompt limit; the row's own limit is checked once it resolves.
const promptCeiling = 200_000;
const maxOptions = 64;

const plain = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" &&
	value !== null &&
	(Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const exactly = (value: Record<string, unknown>, keys: readonly string[]) =>
	Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const scalar = (value: unknown) =>
	typeof value === "string" ||
	typeof value === "boolean" ||
	(typeof value === "number" && Number.isFinite(value));

/** The operation key and draft of a derived request, checked by shape alone. */
function structural(value: Record<string, unknown>) {
	const key = value.operationKey;
	const draft = value.draft;
	if (
		!plain(key) ||
		!exactly(key, keyKeys) ||
		key.provider !== "poyo" ||
		key.route !== "POST /api/generate/submit" ||
		key.operation !== "text-to-image" ||
		typeof key.model !== "string" ||
		!poyoRateKey.test(key.model) ||
		key.model.includes("..") ||
		// A released operation keeps its own reviewed parser.
		resolveOperationKey(key) !== undefined
	)
		return null;
	if (
		!plain(draft) ||
		!exactly(draft, draftKeys) ||
		draft.model !== key.model ||
		draft.operation !== key.operation ||
		typeof draft.prompt !== "string" ||
		draft.prompt.length > promptCeiling ||
		!plain(draft.options) ||
		Object.keys(draft.options).length > maxOptions ||
		!Object.values(draft.options).every(scalar)
	)
		return null;
	return { key: key as QueueKey, draft: structuredClone(draft) as DerivedDraft };
}

/** Parses a derived Queue request, or null. Only Review resolves its row. */
export function parseDerivedRequest(
	value: unknown,
	action: "review" | "submit" = "review",
	rows: DerivedRows = derivedRows,
): DerivedLiveRequest | null {
	if (
		!plain(value) ||
		Object.keys(value).some((key) => !requestKeys.includes(key)) ||
		value.count !== 1 ||
		value.retryLimit !== 0 ||
		typeof value.acceptUnknown !== "boolean"
	)
		return null;
	const parsed = structural(value);
	if (!parsed) return null;
	const live: DerivedLiveRequest = {
		derived: true,
		count: 1,
		retryLimit: 0,
		...parsed,
		acceptUnknown: value.acceptUnknown,
		token: value.token,
	};
	if (action === "submit") return live;
	const resolved = resolveDerived(live, rows);
	return resolved ? { ...live, ...resolved } : null;
}

/**
 * The current row and exact request for a derived draft, or null when the row is gone or no
 * longer accepts the draft: the browser's validation, then both pinned schemas, no defaults.
 */
export function resolveDerived(live: DerivedLiveRequest, rows: DerivedRows = derivedRows) {
	const row = rows.row(live.key);
	const schemas = rows.schemas(live.key);
	if (!row || !schemas) return null;
	const validated = validateDerivedDraft(row, live.draft);
	if (!validated.ok) return null;
	const request = buildDerivedRequest(row, validated.draft);
	if (validateBody(schemas, request.body.input, reviewedRules).length) return null;
	return { row, request };
}
