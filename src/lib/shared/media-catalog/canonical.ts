/** JSON with object keys sorted by UTF-16 code unit and no whitespace. Arrays keep their order. */
export function canonicalJson(value: unknown): string {
	return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortKeys);
	if (!value || typeof value !== "object") return value;
	const record = value as Record<string, unknown>;
	return Object.fromEntries(
		Object.keys(record)
			.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
			.map((key) => [key, sortKeys(record[key])]),
	);
}
