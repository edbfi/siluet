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
) {
	return page.evaluate(
		async ({ purpose, path, fields, binding }) => {
			const installation =
				document.querySelector('meta[name="siluet-installation"]')?.getAttribute("content") ?? "";
			const db = await new Promise<IDBDatabase>((resolve, reject) => {
				const request = indexedDB.open("siluet-owner", 1);
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
		{ purpose, path, fields, binding },
	);
}

/** Claim the studio from this page and land on the authenticated offer, as after Setup. */
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
	const claimed = await signedInPage(page, "claim", "/owner/claim", {
		token: studio.token(),
		username,
		password,
	});
	expect(claimed.status).toBe(200);
	return claimed.body as Issued;
}

/** Sign this page's browser key in with a password, without the form. */
export async function signInOwner(
	page: Page,
	origin: string,
	password: string,
	username = "creator",
) {
	await onOrigin(page, origin);
	const signed = await signedInPage(page, "sign-in", "/owner/sign-in", { username, password });
	expect(signed.status).toBe(200);
	return signed.body as Issued | { proof: string };
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
