import { type KeyMessage, keyMessage, toBase64Url } from "./key-message";

/**
 * The browser key: one non-extractable ECDSA P-256 key per installation in IndexedDB
 * `siluet-owner`. IndexedDB belongs to the exact origin, so another port or address family
 * never sees it. Each claim and sign-in on `/setup` and `/sign-in` makes a candidate that
 * replaces the stored key only once its session is issued.
 */
export type BrowserKey = { key: CryptoKey; spki: string };

const database = "siluet-owner";
const store = "keys";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const isInstallationId = (value: unknown): value is string =>
	typeof value === "string" && uuid.test(value);

function open() {
	return new Promise<IDBDatabase>((resolve, reject) => {
		const request = indexedDB.open(database, 1);
		request.onupgradeneeded = () => request.result.createObjectStore(store);
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
		request.onblocked = () => reject(new Error("Key storage is blocked."));
	});
}
const valid = (value: unknown): value is BrowserKey =>
	typeof value === "object" &&
	value !== null &&
	(value as BrowserKey).key instanceof CryptoKey &&
	typeof (value as BrowserKey).spki === "string";

/** The stored key, read-only. Never creates one. */
export async function readKey(installation: string): Promise<BrowserKey | null> {
	if (!isInstallationId(installation) || typeof indexedDB === "undefined") return null;
	const db = await open();
	try {
		return await new Promise((resolve, reject) => {
			const request = db.transaction(store, "readonly").objectStore(store).get(installation);
			request.onsuccess = () => resolve(valid(request.result) ? request.result : null);
			request.onerror = () => reject(request.error);
		});
	} finally {
		db.close();
	}
}

export async function signWith(record: BrowserKey, message: KeyMessage) {
	const signature = await crypto.subtle.sign(
		{ name: "ECDSA", hash: "SHA-256" },
		record.key,
		keyMessage(message),
	);
	return toBase64Url(new Uint8Array(signature));
}

/** The most specific product token in a user agent, such as `Chrome/159.0` or `Firefox/159.0`. */
export function browserName(userAgent: string) {
	for (const product of ["Edg", "OPR", "Firefox", "Chrome", "Version"]) {
		const token = userAgent.match(new RegExp(`\\b${product}/[\\d.]+`))?.[0];
		if (token) return product === "Version" ? `Safari/${token.slice(8)}` : token;
	}
	return userAgent.split(" ").at(-1) ?? "unknown browser";
}

/** Why this browser cannot keep a key here, naming the address and browser. */
export class KeyUnavailable extends Error {
	constructor() {
		super(
			`This browser cannot keep a sign-in key for ${location.origin}. Open Siluet at this address in a current browser with site data allowed (${browserName(navigator.userAgent)}).`,
		);
	}
}

/** A key that cannot sign (for example after a profile reset) is no key. */
const signs = (installation: string, record: BrowserKey) =>
	signWith(record, {
		purpose: "resume",
		origin: location.origin,
		installation,
		binding: record.spki,
		nonce: "capability-check",
	});

/**
 * The tab's first read of the stored record: the SPKI a commit expects to replace (null if
 * none or malformed), and the record as the base only if it still signs.
 */
export async function readBase(
	installation: string,
): Promise<{ expected: string | null; base: BrowserKey | null }> {
	const record = await readKey(installation);
	if (!record) return { expected: null, base: null };
	const usable = await signs(installation, record).then(
		() => true,
		() => false,
	);
	return { expected: record.spki, base: usable ? record : null };
}

/** A new candidate key, held only in this tab's memory until its commit. */
export async function createCandidate(installation: string): Promise<BrowserKey> {
	if (
		!isInstallationId(installation) ||
		!isSecureContext ||
		!globalThis.crypto?.subtle ||
		typeof indexedDB === "undefined"
	)
		throw new KeyUnavailable();
	try {
		(await open()).close();
		const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, [
			"sign",
			"verify",
		]);
		const spki = toBase64Url(new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey)));
		const candidate: BrowserKey = { key: pair.privateKey, spki };
		await signs(installation, candidate);
		return candidate;
	} catch {
		throw new KeyUnavailable();
	}
}

/**
 * Store `candidate` in one readwrite transaction while the stored SPKI is still `expected`,
 * overwriting an unchanged record that cannot sign. False when another tab stored a key
 * first. Settles only once the transaction completes; a failing write rejects.
 */
export async function commitKey(
	installation: string,
	candidate: BrowserKey,
	expected: string | null,
) {
	const db = await open();
	let committed = false;
	try {
		await new Promise<void>((resolve, reject) => {
			const transaction = db.transaction(store, "readwrite");
			const keys = transaction.objectStore(store);
			const read = keys.get(installation);
			read.onsuccess = () => {
				const stored = valid(read.result) ? read.result.spki : null;
				if (stored === candidate.spki) committed = true;
				else if (stored === expected) {
					keys.put(candidate, installation);
					committed = true;
				}
			};
			transaction.oncomplete = () => resolve();
			transaction.onerror = () => reject(transaction.error);
			transaction.onabort = () => reject(transaction.error);
		});
	} finally {
		db.close();
	}
	if (committed) void navigator.storage?.persist?.().catch(() => {});
	return committed;
}
