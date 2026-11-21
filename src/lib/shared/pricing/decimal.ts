// Bound v1 rates to 12 whole and 6 fractional digits. Use millionths for arithmetic.
const scale = 1_000_000n;
const decimal = /^(0|[1-9][0-9]{0,11})(\.[0-9]{1,6})?$/;

export function isCreditRate(value: unknown): value is string {
	return typeof value === "string" && decimal.test(value) && /[1-9]/.test(value);
}

export function creditUnits(rate: string): bigint {
	if (!decimal.test(rate)) throw new RangeError("Invalid credit decimal.");
	const [whole, fraction = ""] = rate.split(".");
	return BigInt(whole) * scale + BigInt(fraction.padEnd(6, "0"));
}

export function formatCredits(units: bigint): string {
	const negative = units < 0n;
	const magnitude = negative ? -units : units;
	const fraction = (magnitude % scale).toString().padStart(6, "0").replace(/0+$/, "");
	const whole = `${negative ? "-" : ""}${magnitude / scale}`;
	return fraction ? `${whole}.${fraction}` : whole;
}
