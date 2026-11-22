/** Draft and stage handles are random version 4 UUIDs. */
export const opaqueId = (v: unknown): v is string =>
	typeof v === "string" &&
	/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v);
