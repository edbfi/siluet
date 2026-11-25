import { type KeyPurpose, keyMessage, toBase64Url } from "../src/lib/shared/owner/key-message";

/**
 * A browser-key client for tests outside a browser: a WebCrypto P-256 key signs the same
 * challenges a browser tab does and receives bearers for its session.
 */
export async function createOwnerClient(origin: string) {
	const shell = await (await fetch(`${origin}/sign-in`)).text();
	const installation = /<meta name="siluet-installation" content="([0-9a-f-]{36})">/.exec(
		shell,
	)?.[1];
	if (!installation) throw new Error("Missing installation ID.");
	const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, [
		"sign",
		"verify",
	]);
	const spki = toBase64Url(new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey)));
	const post = (path: string, body: unknown) =>
		fetch(`${origin}${path}`, {
			method: "POST",
			headers: { origin, "content-type": "application/json" },
			body: JSON.stringify(body),
		});
	async function signed(
		purpose: KeyPurpose,
		path: string,
		fields: Record<string, unknown>,
		binding = "",
	) {
		const { nonce } = await (await post("/owner/challenge", { purpose })).json();
		const signature = await crypto.subtle.sign(
			{ name: "ECDSA", hash: "SHA-256" },
			pair.privateKey,
			keyMessage({ purpose, origin, installation: installation as string, binding, nonce }),
		);
		return post(path, {
			...fields,
			key: spki,
			nonce,
			signature: toBase64Url(new Uint8Array(signature)),
		});
	}
	let session: { bearer: string; sessionId: string; loginId: string } | null = null;
	async function bind(response: Response) {
		if (!response.ok) throw new Error(`Owner request failed with ${response.status}.`);
		session = await response.json();
		return session as NonNullable<typeof session>;
	}
	return {
		installation,
		spki,
		signed,
		get session() {
			return session;
		},
		claim: async (token: string, username: string, password: string) =>
			bind(await signed("claim", "/owner/claim", { token, username, password })),
		signIn: async (username: string, password: string) =>
			bind(await signed("sign-in", "/owner/sign-in", { username, password })),
		resume: async () => bind(await signed("resume", "/owner/resume", {}, spki)),
		signOut: (loginId: string) => signed("sign-out", "/owner/sign-out", { loginId }, loginId),
		/** Headers for a private request with the current bearer. */
		headers(extra: Record<string, string> = {}) {
			if (!session) throw new Error("Sign in first.");
			return { origin, authorization: `Bearer ${session.bearer}`, ...extra };
		},
	};
}
export type OwnerClient = Awaited<ReturnType<typeof createOwnerClient>>;
