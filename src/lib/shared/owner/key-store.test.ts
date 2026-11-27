import { expect, test } from "bun:test";
import { toBase64Url } from "./key-message";
import { type BrowserKey, browserName, commitKey, createCandidate, readBase } from "./key-store";

// The key error names the browser by its most specific product token, not the last one.
test("the key error names the browser the owner is using", () => {
	const agents = {
		"Chrome/159.0.0.0":
			"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/159.0.0.0 Safari/537.36",
		"Edg/159.0.0.0":
			"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/159.0.0.0 Safari/537.36 Edg/159.0.0.0",
		"Firefox/159.0": "Mozilla/5.0 (X11; Linux x86_64; rv:159.0) Gecko/20100101 Firefox/159.0",
		"Safari/27.2":
			"Mozilla/5.0 (Macintosh; Intel Mac OS X 15_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.2 Safari/605.1.15",
	};
	for (const [name, agent] of Object.entries(agents)) expect(browserName(agent)).toBe(name);
});

/**
 * A small IndexedDB with the one store the key uses. Requests answer on later tasks; a
 * transaction applies its writes and completes once its requests and their handlers ran.
 */
function fakeIndexedDB() {
	const data = new Map<string, unknown>();
	const events: string[] = [];
	const control = { failPut: false };
	const later = (step: () => void) => setTimeout(step, 0);
	const db = {
		close() {},
		transaction(_store: string, _mode: string) {
			const writes = new Map<string, unknown>();
			let open = 0;
			let failed = false;
			let done = false;
			const transaction: Record<string, unknown> & {
				oncomplete?: () => void;
				onerror?: () => void;
				onabort?: () => void;
			} = { error: null };
			const settle = () =>
				later(() => {
					if (open || done) return;
					done = true;
					if (failed) {
						transaction.onerror?.();
						transaction.onabort?.();
						return;
					}
					for (const [key, value] of writes) data.set(key, value);
					events.push("complete");
					transaction.oncomplete?.();
				});
			const request = (run: () => unknown, fail = false) => {
				const req: { result?: unknown; error?: unknown; onsuccess?: () => void } = {};
				open++;
				later(() => {
					open--;
					if (fail) {
						failed = true;
						transaction.error = new DOMException("Quota exceeded.", "QuotaExceededError");
					} else {
						req.result = run();
						req.onsuccess?.();
					}
					settle();
				});
				return req;
			};
			transaction.objectStore = () => ({
				get: (key: string) => request(() => (writes.has(key) ? writes.get(key) : data.get(key))),
				put: (value: unknown, key: string) => {
					events.push("put");
					return request(() => writes.set(key, value), control.failPut);
				},
			});
			return transaction;
		},
	};
	const indexedDB = {
		open() {
			const req: { result?: unknown; onsuccess?: () => void; onupgradeneeded?: () => void } = {};
			later(() => {
				req.result = db;
				req.onsuccess?.();
			});
			return req;
		},
	};
	return { indexedDB, data, events, control };
}

const installation = "7d4f3f0e-2a1b-4c5d-8e9f-0a1b2c3d4e5f";
Object.assign(globalThis, {
	location: { origin: "http://127.0.0.1:4000" },
	isSecureContext: true,
});
async function key(signs = true): Promise<BrowserKey> {
	const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, [
		"sign",
		"verify",
	]);
	const spki = toBase64Url(new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey)));
	// A public key cannot sign, as a record restored without its private key.
	return { key: signs ? pair.privateKey : pair.publicKey, spki };
}
function install() {
	const fake = fakeIndexedDB();
	Object.assign(globalThis, { indexedDB: fake.indexedDB });
	return fake;
}

test("the first read gives the expected SPKI and a base only when the record signs", async () => {
	const fake = install();
	expect(await readBase(installation)).toEqual({ expected: null, base: null });
	fake.data.set(installation, { spki: "not a record" });
	expect(await readBase(installation)).toEqual({ expected: null, base: null });
	const unusable = await key(false);
	fake.data.set(installation, unusable);
	expect(await readBase(installation)).toEqual({ expected: unusable.spki, base: null });
	const usable = await key();
	fake.data.set(installation, usable);
	expect(await readBase(installation)).toEqual({ expected: usable.spki, base: usable });
});

test("a candidate is checked and held in memory only", async () => {
	const fake = install();
	const candidate = await createCandidate(installation);
	expect(candidate.key.type).toBe("private");
	expect(candidate.key.extractable).toBe(false);
	expect(fake.data.size).toBe(0);
	Object.assign(globalThis, { isSecureContext: false });
	await expect(createCandidate(installation)).rejects.toThrow("cannot keep a sign-in key");
	Object.assign(globalThis, { isSecureContext: true });
});

test("the commit puts the candidate only while the stored SPKI is the expected one", async () => {
	const fake = install();
	// An absent record.
	const first = await key();
	expect(await commitKey(installation, first, null)).toBe(true);
	expect(fake.data.get(installation)).toBe(first);
	// The base it read.
	const second = await key();
	expect(await commitKey(installation, second, first.spki)).toBe(true);
	expect(fake.data.get(installation)).toBe(second);
	// An unchanged record that cannot sign is overwritten.
	const unusable = await key(false);
	fake.data.set(installation, unusable);
	const third = await key();
	expect(await commitKey(installation, third, unusable.spki)).toBe(true);
	expect(fake.data.get(installation)).toBe(third);
	// Another tab replaced it: refused, and the stored record stays.
	const late = await key();
	expect(await commitKey(installation, late, second.spki)).toBe(false);
	expect(fake.data.get(installation)).toBe(third);
	expect(await commitKey(installation, late, null)).toBe(false);
	expect(fake.data.get(installation)).toBe(third);
});

test("the commit settles only once its transaction completes, and a failing put rejects", async () => {
	const fake = install();
	const candidate = await key();
	await commitKey(installation, candidate, null).then(() => fake.events.push("settled"));
	expect(fake.events).toEqual(["put", "complete", "settled"]);
	fake.control.failPut = true;
	const stored = fake.data.get(installation);
	await expect(commitKey(installation, await key(), candidate.spki)).rejects.toThrow("Quota");
	expect(fake.data.get(installation)).toBe(stored);
});
