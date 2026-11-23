import { TruncatedVideoError, UnsupportedVideoError } from "./errors";

// Recognise an EBML (WebM or Matroska) file from its header so it gets its own message.
// RFC 8794 §4 (variable-size integers) and §11.2 (EBML header, DocType 0x4282).

export const sniffBytes = 4096;
const ebmlMagic = 0x1a45dfa3;
const docTypeId = 0x4282;

/** A variable-size integer at `at`, or null when it runs past the buffer. */
function vint(bytes: Buffer, at: number, keepMarker: boolean) {
	if (at >= bytes.length) return null;
	const first = bytes[at];
	const length = Math.clz32(first) - 23;
	if (length < 1 || length > 8 || at + length > bytes.length) return null;
	let value = keepMarker ? first : first & (0xff >> length);
	for (let i = 1; i < length; i++) value = value * 256 + bytes[at + i];
	return { value, length };
}

/**
 * Refuse an EBML file from the first `sniffBytes` of a file of `size` bytes.
 * Returns without throwing when the file is not EBML.
 */
export function refuseEbml(head: Buffer, size: number) {
	if (head.length < 4 || head.readUInt32BE(0) !== ebmlMagic) return;
	const ran = () =>
		head.length >= size ? new TruncatedVideoError() : new UnsupportedVideoError("EBML header");
	const header = vint(head, 4, false);
	if (!header) throw ran();
	const end = 4 + header.length + header.value;
	let at = 4 + header.length;
	while (at < Math.min(end, head.length)) {
		const id = vint(head, at, true);
		const length = id && vint(head, at + id.length, false);
		if (!id || !length) break;
		const start = at + id.length + length.length;
		if (start + length.value > head.length) break;
		if (id.value === docTypeId) {
			const type = head.toString("latin1", start, start + length.value).replace(/\0+$/, "");
			if (type === "webm" || type === "matroska")
				throw new UnsupportedVideoError(`${type} container`, "webm");
			throw new UnsupportedVideoError(`EBML document type ${type}`);
		}
		at = start + length.value;
	}
	throw ran();
}
