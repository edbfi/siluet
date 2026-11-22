import { refuseJpeg } from "./jpeg-errors";

export type Rational = readonly [bigint, bigint];
export type Density = { x: Rational; y: Rational; unit?: number };

export function resolutionRational(value: string): Rational {
	const match = /^\+?(\d{1,10})(?:\/\+?(\d{1,10}))?$/.exec(value.trim());
	if (!match) refuseJpeg("aspect");
	const x = BigInt(match[1]);
	const y = BigInt(match[2] ?? "1");
	if (!x || !y || x > 0xffff_ffffn || y > 0xffff_ffffn) refuseJpeg("aspect");
	return [x, y];
}

function inPixelsPerInch([n, d]: Rational, unit: number | undefined): Rational {
	// 1 inch = 2.54 centimetres.
	return unit === 3 ? [n * 254n, d * 100n] : [n, d];
}

function same([a, b]: Rational, [c, d]: Rational) {
	return a * d === c * b;
}

export function checkDensity(jfif: Buffer | undefined, densities: Density[], aspect?: number) {
	const h = BigInt(jfif?.readUInt16BE(8) ?? 1);
	const v = BigInt(jfif?.readUInt16BE(10) ?? 1);
	if (aspect !== undefined && aspect !== Number(v) / Number(h)) refuseJpeg("aspect");
	const retained: Density = { x: [h, 1n], y: [v, 1n], unit: (jfif?.[7] ?? 0) + 1 };
	const physical = [retained, ...densities].filter(({ unit }) => unit === 2 || unit === 3);
	for (const {
		x: [xn, xd],
		y: [yn, yd],
	} of densities) {
		if (xn * yd * v !== yn * xd * h) refuseJpeg("aspect");
	}
	// Without a retained physical unit the reference still preserves aspect.
	// When multiple carriers specify a physical density they must also agree.
	const [first, ...other] = physical;
	if (!first) return;
	for (const { x, y, unit } of other) {
		if (
			!same(inPixelsPerInch(x, unit), inPixelsPerInch(first.x, first.unit)) ||
			!same(inPixelsPerInch(y, unit), inPixelsPerInch(first.y, first.unit))
		)
			refuseJpeg("aspect");
	}
}
