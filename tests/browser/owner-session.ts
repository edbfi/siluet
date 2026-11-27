import { expect, type Page } from "@playwright/test";

/**
 * Sign the page's browser key into the studio the way the app does, from inside the page:
 * the key lives in the origin's IndexedDB and never leaves the browser. The page's next
 * document load resumes that session.
 */
type Purpose = "claim" | "sign-in" | "factor" | "resume" | "sign-out";
type Issued = { bearer: string; sessionId: string; loginId: string };
type Studio = { origin: URL; token: () => string };

async function onOrigin(page: Page, origin: string) {
	if (new URL(page.url()).origin === origin) return;
	await page.goto(`${origin}/sign-in`);
	// Let the page's own start-up requests settle before signing from it.
	await page.waitForLoadState("networkidle");
}

/** Run one signed owner request in the page with its stored (or a new) browser key. */
export async function signedInPage(
	page: Page,
	purpose: Purpose,
	path: string,
	fields: Record<string, unknown>,
	binding: "" | "key" | { proof: string } | { value: string } = "",
	/** Sign with the key `keepKey` copied before a rotation instead of the stored one. */
	kept = false,
) {
	return page.evaluate(
		async ({ purpose, path, fields, binding, kept }) => {
			const installation =
				document.querySelector('meta[name="siluet-installation"]')?.getAttribute("content") ?? "";
			const db = await new Promise<IDBDatabase>((resolve, reject) => {
				const request = indexedDB.open(kept ? "siluet-test-kept" : "siluet-owner", 1);
				request.onupgradeneeded = () => request.result.createObjectStore("keys");
				request.onsuccess = () => resolve(request.result);
				request.onerror = () => reject(request.error);
			});
			const stored = await new Promise<{ key: CryptoKey; spki: string } | undefined>(
				(resolve, reject) => {
					const request = db.transaction("keys").objectStore("keys").get(installation);
					request.onsuccess = () => resolve(request.result);
					request.onerror = () => reject(request.error);
				},
			);
			const base64url = (bytes: Uint8Array) =>
				btoa(String.fromCharCode(...bytes))
					.replaceAll("+", "-")
					.replaceAll("/", "_")
					.replace(/=+$/, "");
			let record = stored;
			if (!record) {
				const pair = await crypto.subtle.generateKey(
					{ name: "ECDSA", namedCurve: "P-256" },
					false,
					["sign", "verify"],
				);
				const spki = base64url(
					new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey)),
				);
				record = { key: pair.privateKey, spki };
				const fresh = record;
				await new Promise<void>((resolve, reject) => {
					const transaction = db.transaction("keys", "readwrite");
					transaction.objectStore("keys").put(fresh, installation);
					transaction.oncomplete = () => resolve();
					transaction.onerror = () => reject(transaction.error);
				});
			}
			db.close();
			const post = (url: string, body: unknown) =>
				fetch(url, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(body),
				});
			const { nonce } = await (await post("/owner/challenge", { purpose })).json();
			const bound =
				binding === ""
					? ""
					: binding === "key"
						? record.spki
						: "value" in binding
							? binding.value
							: Array.from(
									new Uint8Array(
										await crypto.subtle.digest("SHA-256", new TextEncoder().encode(binding.proof)),
									),
									(b) => b.toString(16).padStart(2, "0"),
								).join("");
			const message = new TextEncoder().encode(
				["siluet-browser-key/1", purpose, location.origin, installation, bound, nonce].join("\n"),
			);
			const signature = base64url(
				new Uint8Array(
					await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, record.key, message),
				),
			);
			const response = await post(path, { ...fields, key: record.spki, nonce, signature });
			return { status: response.status, body: await response.json().catch(() => null) };
		},
		{ purpose, path, fields, binding, kept },
	);
}

/**
 * Claim or sign in from inside the page as the forms do: sign with a new candidate key, name
 * the stored key in `replaces` when it can sign (sign-in only), finish the factor step with
 * `code`, and store the candidate only once its session is issued and the stored key is still
 * the one first read. Returns the issued session, or the pending proof without a code.
 */
async function rotate(
	page: Page,
	purpose: "claim" | "sign-in",
	fields: Record<string, unknown>,
	code?: string,
) {
	return page.evaluate(
		async ({ purpose, fields, code }) => {
			const installation =
				document.querySelector('meta[name="siluet-installation"]')?.getAttribute("content") ?? "";
			const open = () =>
				new Promise<IDBDatabase>((resolve, reject) => {
					const request = indexedDB.open("siluet-owner", 1);
					request.onupgradeneeded = () => request.result.createObjectStore("keys");
					request.onsuccess = () => resolve(request.result);
					request.onerror = () => reject(request.error);
				});
			type Key = { key: CryptoKey; spki: string };
			const read = async () => {
				const db = await open();
				try {
					return await new Promise<Key | undefined>((resolve, reject) => {
						const request = db.transaction("keys").objectStore("keys").get(installation);
						request.onsuccess = () => resolve(request.result);
						request.onerror = () => reject(request.error);
					});
				} finally {
					db.close();
				}
			};
			const base64url = (bytes: Uint8Array) =>
				btoa(String.fromCharCode(...bytes))
					.replaceAll("+", "-")
					.replaceAll("/", "_")
					.replace(/=+$/, "");
			const sign = async (key: CryptoKey, purpose: string, binding: string, nonce: string) =>
				base64url(
					new Uint8Array(
						await crypto.subtle.sign(
							{ name: "ECDSA", hash: "SHA-256" },
							key,
							new TextEncoder().encode(
								[
									"siluet-browser-key/1",
									purpose,
									location.origin,
									installation,
									binding,
									nonce,
								].join("\n"),
							),
						),
					),
				);
			const post = (url: string, body: unknown) =>
				fetch(url, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(body),
				});
			const stored = await read();
			const base =
				purpose === "sign-in" && stored
					? await sign(stored.key, "resume", stored.spki, "capability-check").then(
							() => stored,
							() => null,
						)
					: null;
			const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, [
				"sign",
				"verify",
			]);
			const candidate: Key = {
				key: pair.privateKey,
				spki: base64url(new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey))),
			};
			async function send(purpose: string, body: Record<string, unknown>, binding: string) {
				const { nonce } = await (await post("/owner/challenge", { purpose })).json();
				const signed: Record<string, unknown> = {
					...body,
					key: candidate.spki,
					nonce,
					signature: await sign(candidate.key, purpose, binding, nonce),
				};
				if (base)
					signed.replaces = {
						key: base.spki,
						signature: await sign(base.key, purpose, `replaces:${candidate.spki}`, nonce),
					};
				const response = await post(`/owner/${purpose}`, signed);
				return { status: response.status, body: await response.json().catch(() => null) };
			}
			let answer = await send(purpose, fields, "");
			if (answer.status === 200 && typeof answer.body?.proof === "string" && code !== undefined) {
				const proof = answer.body.proof;
				const digest = Array.from(
					new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(proof))),
					(byte) => byte.toString(16).padStart(2, "0"),
				).join("");
				answer = await send("factor", { proof, code }, digest);
			}
			if (answer.status !== 200 || typeof answer.body?.bearer !== "string") return answer;
			// Compare and swap, as the app's commit does.
			const db = await open();
			const committed = await new Promise<boolean>((resolve, reject) => {
				const transaction = db.transaction("keys", "readwrite");
				const keys = transaction.objectStore("keys");
				let put = false;
				const current = keys.get(installation);
				current.onsuccess = () => {
					if ((current.result?.spki ?? null) !== (stored?.spki ?? null)) return;
					keys.put(candidate, installation);
					put = true;
				};
				transaction.oncomplete = () => resolve(put);
				transaction.onerror = () => reject(transaction.error);
			});
			db.close();
			return committed ? answer : { status: 0, body: null };
		},
		{ purpose, fields, code },
	);
}

/** Claim the studio from this page with a new key, as Setup does, and keep it once claimed. */
export async function claimOwner(
	page: Page,
	studio: Studio,
	password: string,
	username = "creator",
) {
	const origin = studio.origin.origin;
	await expect.poll(studio.token).not.toBe("");
	if (new URL(page.url()).origin !== origin) {
		await page.goto(`${origin}/setup`);
		await page.waitForLoadState("networkidle");
	}
	const claimed = await rotate(page, "claim", { token: studio.token(), username, password });
	expect(claimed.status).toBe(200);
	return claimed.body as Issued;
}

/**
 * Sign this page's browser in with a password, without the form, rotating its key as the form
 * does. With two-step sign-in, `code` finishes the factor step; without it the pending proof
 * is returned and nothing is stored.
 */
export async function signInOwner(
	page: Page,
	origin: string,
	password: string,
	username = "creator",
	code?: string,
) {
	await onOrigin(page, origin);
	const signed = await rotate(page, "sign-in", { username, password }, code);
	expect(signed.status).toBe(200);
	return signed.body as Issued | { proof: string };
}

/**
 * Copy the stored key into a test-owned store before a rotation, so a later check can sign
 * with the key the browser no longer keeps.
 */
export async function keepKey(page: Page) {
	await page.evaluate(async () => {
		const installation =
			document.querySelector('meta[name="siluet-installation"]')?.getAttribute("content") ?? "";
		const open = (name: string) =>
			new Promise<IDBDatabase>((resolve, reject) => {
				const request = indexedDB.open(name, 1);
				request.onupgradeneeded = () => request.result.createObjectStore("keys");
				request.onsuccess = () => resolve(request.result);
				request.onerror = () => reject(request.error);
			});
		const owner = await open("siluet-owner");
		const record = await new Promise<unknown>((resolve, reject) => {
			const request = owner.transaction("keys").objectStore("keys").get(installation);
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error);
		});
		owner.close();
		const kept = await open("siluet-test-kept");
		await new Promise<void>((resolve, reject) => {
			const transaction = kept.transaction("keys", "readwrite");
			transaction.objectStore("keys").put(record, installation);
			transaction.oncomplete = () => resolve();
			transaction.onerror = () => reject(transaction.error);
		});
		kept.close();
	});
}

/**
 * Private API requests on the page's session, as the app sends them: a bearer from this
 * page's browser key, renewed once when the hook refuses it.
 */
const requests = new WeakMap<Page, ReturnType<typeof createOwnerRequest>>();
export function ownerRequest(page: Page) {
	const known = requests.get(page);
	if (known) return known;
	const client = createOwnerRequest(page);
	requests.set(page, client);
	return client;
}
function createOwnerRequest(page: Page) {
	let bearer: string | null = null;
	type Options = NonNullable<Parameters<Page["request"]["fetch"]>[1]>;
	async function send(url: string, options: Options = {}) {
		for (let attempt = 0; ; attempt++) {
			if (!bearer) {
				await onOrigin(page, new URL(url).origin);
				const resumed = await signedInPage(page, "resume", "/owner/resume", {}, "key");
				if (resumed.status !== 200) throw new Error(`No owner session (${resumed.status}).`);
				bearer = (resumed.body as Issued).bearer;
			}
			const response = await page.request.fetch(url, {
				...options,
				headers: { ...options.headers, authorization: `Bearer ${bearer}` },
			});
			const refused = (response.headers()["www-authenticate"] ?? "").includes("invalid_token");
			if (response.status() !== 401 || !refused || attempt) return response;
			bearer = null;
		}
	}
	return {
		fetch: send,
		get: (url: string, options: Options = {}) => send(url, { ...options, method: "GET" }),
		head: (url: string, options: Options = {}) => send(url, { ...options, method: "HEAD" }),
		post: (url: string, options: Options = {}) => send(url, { ...options, method: "POST" }),
		delete: (url: string, options: Options = {}) => send(url, { ...options, method: "DELETE" }),
		/** Forget the bearer, as after a server restart. */
		reset() {
			bearer = null;
		},
	};
}

/** Connect a provider key through the Providers action, as the form would. */
export async function connectProvider(page: Page, origin: string, provider: string, key: string) {
	const response = await ownerRequest(page).post(`${origin}/settings/providers?/connect`, {
		headers: { origin, "x-sveltekit-action": "true" },
		form: { provider, key },
	});
	expect(response.ok()).toBe(true);
	expect((await response.json()).type).toBe("success");
}
