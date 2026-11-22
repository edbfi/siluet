// RFC 9110 sections 14.1.2 and 14.2. Ignore unsupported or invalid syntax.
export function byteRange(
	value: string | null,
	size: number,
): readonly [number, number] | "unsatisfiable" | null {
	const match = value && /^bytes=(\d*)-(\d*)$/i.exec(value.trim());
	if (!match || (!match[1] && !match[2])) return null;
	const end = BigInt(size) - 1n;
	if (!match[1]) {
		const suffix = BigInt(match[2]);
		if (!suffix || !size) return "unsatisfiable";
		return [suffix >= size ? 0 : size - Number(suffix), Number(end)];
	}
	const start = BigInt(match[1]);
	const stop = match[2] ? BigInt(match[2]) : end;
	if (match[2] && stop < start) return null;
	if (start > end) return "unsatisfiable";
	return [Number(start), Number(stop < end ? stop : end)];
}
