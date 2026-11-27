// The server's reader of the pinned schemas each derived Queue row re-validates against
// (queue-schemas.json, written by `bun run catalog:derive`). Never shipped to the browser.
import type { QueueKey } from "../../../shared/media-catalog/queue-row";
import type { RowSchemas, Schema } from "../../../shared/media-catalog/schema";
import pinned from "./queue-schemas.json";

const projection = pinned as unknown as {
	rows: Record<string, { catalog: string; rest: string | null }>;
	schemas: Record<string, Schema>;
};

/** Both pinned schemas of one derived Queue row, or undefined when the row is not eligible. */
export function queueSchemas(key: QueueKey): RowSchemas | undefined {
	const id = `${key.model} ${key.operation}`;
	if (!Object.hasOwn(projection.rows, id)) return undefined;
	const { catalog, rest } = projection.rows[id];
	return {
		catalog: { schema: projection.schemas[catalog], sha256: catalog },
		rest: rest ? { schema: projection.schemas[rest], sha256: rest } : null,
	};
}
