export const poyoV2Feed = {
	version: 2,
	provider: "poyo",
	revision: "747e5d75319585d66396a3c05bd1b97d9390ce74",
	sourceDate: "2026-11-19T13:42:30Z",
	confirmedAt: "2026-11-22T13:30:00Z",
	rates: {
		"z-image": { kind: "per-request", credits: "2" },
		"seedream-5.5": {
			kind: "per-image-with-references",
			resolutions: { "1K": "4", "1.5K": "4", "2K": "7" },
			perReference: "1.6",
		},
	},
} as const;

/** The v1 feed with the same revision and rates, as older installations read it. */
export const poyoV1Feed = {
	version: 1,
	provider: "poyo",
	revision: poyoV2Feed.revision,
	sourceDate: poyoV2Feed.sourceDate,
	rates: poyoV2Feed.rates,
} as const;

const maxDecimal = "999999999999.999999";

function deepRate(depth: number): Record<string, unknown> {
	let value: Record<string, unknown> = { a: maxDecimal };
	for (let level = 1; level < depth; level++) value = { n: value };
	// An unfamiliar kind of the same length as the H3 kind, which builds now decode strictly.
	return { kind: "per-minute-by-resolution", ...value };
}

/**
 * Pad a valid v2 feed with unfamiliar rates until its compact JSON plus the trailing LF is
 * exactly `bytes` long. `depth` sets how many objects deep each padding rate nests.
 */
export function sizedPoyoV2Feed(
	bytes: number,
	{
		depth = 4,
		base = poyoV2Feed,
	}: { depth?: number; base?: { readonly rates: object; readonly [field: string]: unknown } } = {},
) {
	const rates: Record<string, unknown> = { ...base.rates };
	const feed = { ...base, rates };
	const size = () => new TextEncoder().encode(`${JSON.stringify(feed)}\n`).byteLength;
	const rate = deepRate(depth);
	let index = 0;
	// Each added rate costs its key plus at least `"":` and a comma.
	const cost = JSON.stringify(rate).length + 4;
	while (bytes - size() - cost > 128) rates[`pad-${index++}`] = rate;
	const remaining = bytes - size() - cost;
	const key = "k".repeat(remaining);
	if (remaining < 1 || remaining > 128) throw new RangeError(`Cannot pad to ${bytes} bytes.`);
	rates[key] = rate;
	if (size() !== bytes) throw new RangeError(`Padded feed is ${size()} bytes, not ${bytes}.`);
	return feed;
}
