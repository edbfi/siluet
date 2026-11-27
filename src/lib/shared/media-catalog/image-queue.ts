// The browser's and the server's reader of the derived Queue rows (poyo-queue.json). The
// deriver never imports it: it writes the projection this module reads. Released operations
// stay in the registry; a derived row resolves only here.
import projection from "./poyo-queue.json";
import type { QueueKey, QueueProjection, QueueRow } from "./queue-row";

const queue = projection as unknown as QueueProjection;

/** The pinned catalog revision the Queue rows derive from. */
export const queueRevision = queue.revision;
export const queueRows: readonly QueueRow[] = queue.rows;

const sameKey = (a: QueueKey, b: QueueKey) =>
	a.provider === b.provider &&
	a.model === b.model &&
	a.route === b.route &&
	a.operation === b.operation;

/** The current Queue row for an exact operation key, or undefined when none is eligible. */
export function queueRowFor(key: QueueKey) {
	return queueRows.find((row) => sameKey(row.key, key));
}
