// ICC.1 §10.15 and ICC v2 textDescriptionType. Keep profile names private.
const utf16 = new TextDecoder("utf-16be", { fatal: true });

function asciiText(bytes: Buffer) {
	if (bytes.length === 0 || bytes.at(-1) !== 0) return;
	const text = bytes.subarray(0, -1);
	if (text.some((byte) => byte === 0 || byte > 127)) return;
	return text.toString("ascii");
}

function localizedText(element: Buffer) {
	if (element.length < 16 || element.readUInt32BE(12) !== 12) return;
	const count = element.readUInt32BE(8);
	const end = 16 + 12 * count;
	if (count === 0 || end > element.length) return;
	const texts = new Set<string>();
	const strings = new Map<number, number>();
	let budget = element.length - end;
	for (let record = 16; record < end; record += 12) {
		const length = element.readUInt32BE(record + 4);
		const offset = element.readUInt32BE(record + 8);
		if (offset < end || offset % 2 || length % 2 || offset + length > element.length) return;
		if (strings.get(offset) === length) continue;
		if (strings.has(offset) || length > budget) return;
		budget -= length;
		strings.set(offset, length);
		try {
			texts.add(utf16.decode(element.subarray(offset, offset + length)));
		} catch {
			return;
		}
	}
	return texts;
}

export function profileText(element: Buffer | undefined, type: "mluc" | "text" | "desc") {
	if (
		!element ||
		element.length < 8 ||
		element.readUInt32BE(4) !== 0 ||
		element.toString("latin1", 0, 4) !== type
	)
		return;
	if (type === "mluc") return localizedText(element);
	if (type === "text") {
		const value = asciiText(element.subarray(8));
		if (value !== undefined) return new Set([value]);
		return;
	}
	if (element.length < 12) return;
	const unicode = 12 + element.readUInt32BE(8);
	if (unicode + 8 > element.length) return;
	const script = unicode + 8 + 2 * element.readUInt32BE(unicode + 4);
	if (script + 70 > element.length || element[script + 2] > 67) return;
	const value = asciiText(element.subarray(12, unicode));
	if (value !== undefined) return new Set([value]);
}
