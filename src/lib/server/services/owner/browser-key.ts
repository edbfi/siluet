import { fromBase64Url, type KeyMessage, keyMessage } from "../../../shared/owner/key-message";

const algorithm = { name: "ECDSA", namedCurve: "P-256" } as const;

/**
 * Import a browser key sent as base64url SPKI. Only a P-256 key whose SPKI re-encodes to
 * exactly the bytes sent is accepted, so one key has one spelling in storage.
 */
export async function importBrowserKey(spki: unknown) {
	const der = fromBase64Url(spki);
	// An uncompressed P-256 SPKI is 91 bytes.
	if (der?.length !== 91) return null;
	try {
		const key = await crypto.subtle.importKey("spki", der, algorithm, true, ["verify"]);
		const canonical = new Uint8Array(await crypto.subtle.exportKey("spki", key));
		if (canonical.length !== der.length || canonical.some((byte, i) => byte !== der[i]))
			return null;
		return key;
	} catch {
		return null;
	}
}

/** Verify a 64-byte IEEE P1363 ECDSA P-256 SHA-256 signature over the request's message. */
export async function verifyKeySignature(spki: unknown, signature: unknown, message: KeyMessage) {
	const key = await importBrowserKey(spki);
	const bytes = fromBase64Url(signature);
	if (!key || !bytes || bytes.length !== 64) return false;
	try {
		return await crypto.subtle.verify(
			{ name: "ECDSA", hash: "SHA-256" },
			key,
			bytes,
			keyMessage(message),
		);
	} catch {
		return false;
	}
}
