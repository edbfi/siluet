// The browser's and the server's reader of the derived Queue rows (poyo-queue.json). The
// deriver never imports it: it writes the projection this module reads.
import projection from "./poyo-queue.json";
import type { QueueProjection } from "./queue-row";

const queue = projection as unknown as QueueProjection;

/** The pinned catalog revision the Queue rows derive from. */
export const queueRevision = queue.revision;
