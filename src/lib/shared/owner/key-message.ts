/**
 * The message a browser key signs for one owner request ([browser key sessions](../../../../docs/SPEC-browser-key.md)).
 * Browser and server build it the same way, so a signature only proves the request it was made for.
 */
export const keyPurposes = ["claim", "sign-in", "factor", "resume", "sign-out"] as const;
export type KeyPurpose = (typeof keyPurposes)[number];

export const isKeyPurpose = (value: unknown): value is KeyPurpose =>
	typeof value === "string" && (keyPurposes as readonly string[]).includes(value);

export type KeyMessage = {
	purpose: KeyPurpose;
	/** The canonical origin, such as `http://127.0.0.1:3000`. */
	origin: string;
	installation: string;
	/** Empty for claim and sign-in; the pending proof's digest, the SPKI or the login ID otherwise. */
	binding: string;
	nonce: string;
};

export function keyMessage({ purpose, origin, installation, binding, nonce }: KeyMessage) {
	return new TextEncoder().encode(
		["siluet-browser-key/1", purpose, origin, installation, binding, nonce].join("\n"),
	);
}

const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** Unpadded base64url. */
export function toBase64Url(bytes: Uint8Array) {
	let text = "";
	for (let i = 0; i < bytes.length; i += 3) {
		const [a, b = 0, c = 0] = [bytes[i], bytes[i + 1], bytes[i + 2]];
		const word = (a << 16) | (b << 8) | c;
		text += alphabet[word >> 18] + alphabet[(word >> 12) & 63];
		if (i + 1 < bytes.length) text += alphabet[(word >> 6) & 63];
		if (i + 2 < bytes.length) text += alphabet[word & 63];
	}
	return text;
}

/** Strict unpadded base64url: any other spelling of the same bytes is refused. */
export function fromBase64Url(text: unknown): Uint8Array<ArrayBuffer> | null {
	if (typeof text !== "string" || !/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1)
		return null;
	const bytes = new Uint8Array(Math.floor((text.length * 3) / 4));
	let word = 0;
	let bits = 0;
	let index = 0;
	for (const char of text) {
		word = (word << 6) | alphabet.indexOf(char);
		bits += 6;
		if (bits >= 8) {
			bits -= 8;
			bytes[index++] = (word >> bits) & 255;
		}
	}
	// Leftover bits must be zero, so each byte string has exactly one encoding.
	if (word & ((1 << bits) - 1)) return null;
	return bytes;
}
