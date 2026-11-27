// The Queue projections of the derived Poyo.ai rows. `bun run catalog:derive` writes
// src/lib/shared/media-catalog/poyo-queue.json, the rows the browser's composer and Review read,
// and src/lib/server/providers/poyo/queue-schemas.json, the schemas the server re-validates each
// request against. A row joins only when every static Queue condition holds; any other row is
// pending with the first condition it fails.
import { canonicalJson } from "../../src/lib/shared/media-catalog/canonical";
import type { QueueProjection, QueueRow } from "../../src/lib/shared/media-catalog/queue-row";
import { releasedOperations } from "../../src/lib/shared/media-catalog/registry";
import type { Schema } from "../../src/lib/shared/media-catalog/schema";
import { type DerivedRow, deriveRows } from "./derive";
import { queueRow, rowSchemas } from "./queue-build";
import record from "./sources/sources.json";

export { imagePromptEnvelope, queueRow } from "./queue-build";

const operation = "text-to-image";
// Each released Poyo.ai model keeps its reviewed descriptor and shipped Queue path.
const verified = new Set<string>(
	releasedOperations.filter(({ key }) => key.provider === "poyo").map(({ key }) => key.model),
);
const queueing = new Set(["declared", "open-absent", "open-absent-fixed"]);

export type PendingQueueRow = { model: string; operation: string; reason: string };

/** Every Queue-eligible text-to-image row, and why each other candidate is pending. */
export function queueProjection(rows: DerivedRow[] = deriveRows()) {
	const eligible: QueueRow[] = [];
	const pending: PendingQueueRow[] = [];
	for (const row of rows) {
		if (
			row.media !== "image" ||
			!row.operations.includes(operation) ||
			!queueing.has(row.d4.d4) ||
			verified.has(row.model)
		)
			continue;
		const made = queueRow(row);
		if (typeof made === "string") pending.push({ model: row.model, operation, reason: made });
		else eligible.push(made);
	}
	return { revision: record.catalog.revision, rows: eligible, pending };
}

/** Canonical compact JSON of the browser's queue rows, with one final newline. */
export function renderQueue(rows?: DerivedRow[]) {
	const { revision, rows: eligible } = queueProjection(rows);
	const projection: QueueProjection = { revision, rows: eligible };
	return `${canonicalJson(projection)}\n`;
}

/** Canonical compact JSON of the server's schemas for each queue row, with one final newline. */
export function renderQueueSchemas(rows?: DerivedRow[]) {
	const derived = rows ?? deriveRows();
	const { rows: eligible } = queueProjection(derived);
	const bound: Record<string, { catalog: string; rest: string | null }> = {};
	const schemas: Record<string, Schema> = {};
	for (const entry of eligible) {
		const row = derived.find((candidate) => candidate.model === entry.key.model) as DerivedRow;
		const pinned = rowSchemas(row);
		bound[`${entry.key.model} ${entry.key.operation}`] = entry.schemas;
		schemas[pinned.catalog.sha256] = pinned.catalog.schema;
		if (pinned.rest) schemas[pinned.rest.sha256] = pinned.rest.schema;
	}
	return `${canonicalJson({ rows: bound, schemas })}\n`;
}

export const queuePath = new URL(
	"../../src/lib/shared/media-catalog/poyo-queue.json",
	import.meta.url,
);
export const queueSchemasPath = new URL(
	"../../src/lib/server/providers/poyo/queue-schemas.json",
	import.meta.url,
);
