import { beforeEach, describe, expect, test } from "bun:test";
import { authenticatedFetch } from "./authenticated-fetch";
import { toBase64Url } from "./key-message";
import type { BrowserKey } from "./key-store";
import { createSessionClient } from "./session-client";

// The wrapper's table rows ([browser key sessions](../../../../docs/SPEC-browser-key.md)), against
// a fake studio. Each case states the server's answers and what the tab and the request see.
const origin = "http://127.0.0.1:4000";
const installation = "7d4f3f0e-2a1b-4c5d-8e9f-0a1b2c3d4e5f";
const page = { href: `${origin}/jobs`, pathname: "/jobs" };
Object.assign(globalThis, {
	location: {
		origin,
		get href() {
			return page.href;
		},
		get pathname() {
			return page.pathname;
		},
	},
	document: { visibilityState: "visible" },
	localStorage: { setItem() {}, getItem: () => null },
});

const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, [
	"sign",
	"verify",
]);
const key: BrowserKey = {
	key: pair.privateKey,
	spki: toBase64Url(new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey))),
};

type Answer = { status: number; body?: unknown; headers?: Record<string, string> };
const json = ({ status, body, headers = {} }: Answer) =>
	new Response(body === undefined ? null : JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json", ...headers },
	});
const refused = (invalid = true): Answer => ({
	status: 401,
	body: { message: "Sign in.", location: "/sign-in" },
	headers: { "www-authenticate": `Bearer${invalid ? ' error="invalid_token"' : ""}` },
});
const session = (sessionId: string, bearer = `bearer-${sessionId}`) => ({
	status: 200,
	body: { bearer, sessionId, loginId: "login-1" },
});
const access = { message: "Retry.", retry: true, recoveryRequired: false };

function harness({ stored = key as BrowserKey | null } = {}) {
	const resumes: Answer[] = [];
	const routes: ((request: Request) => Answer | Promise<Answer>)[] = [];
	const sent: Request[] = [];
	const credentials: (RequestCredentials | undefined)[] = [];
	const navigations: string[] = [];
	const native = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const request = new Request(
			new URL(String(input instanceof Request ? input.url : input), origin),
			init,
		);
		const path = new URL(request.url).pathname;
		if (path === "/owner/challenge") return json({ status: 200, body: { nonce: "n" } });
		if (path === "/owner/resume") return json(resumes.shift() ?? { status: 500 });
		sent.push(request);
		credentials.push(init?.credentials);
		return json(await (routes.shift() ?? (() => ({ status: 200, body: { ok: true } })))(request));
	}) as typeof fetch;
	const client = createSessionClient(
		installation,
		native,
		{
			assign: (url) => navigations.push(`assign ${url}`),
			reload: () => navigations.push("reload"),
			replace: (url) => navigations.push(`replace ${url}`),
		},
		{ read: async () => stored, ensure: async () => key },
	);
	return {
		fetch: authenticatedFetch(client, native),
		client,
		resumes,
		routes,
		sent,
		credentials,
		navigations,
	};
}
const settled = <T>(promise: Promise<T>) =>
	Promise.race([
		promise.then(
			() => "settled" as const,
			() => "settled" as const,
		),
		Bun.sleep(50).then(() => "pending" as const),
	]);

beforeEach(() => {
	page.href = `${origin}/jobs`;
	page.pathname = "/jobs";
});

describe("a keyed tab", () => {
	test("binds on its first resume and sends the bearer without cookies", async () => {
		const h = harness();
		h.resumes.push(session("s1"));
		expect((await h.fetch("/jobs/__data.json")).status).toBe(200);
		expect(h.sent[0].headers.get("authorization")).toBe("Bearer bearer-s1");
		expect(h.credentials[0]).toBe("omit");
		expect(h.client.bound()?.sessionId).toBe("s1");
		// A live bearer goes out without another resume.
		await h.fetch("/settings/files/state");
		expect(h.sent[1].headers.get("authorization")).toBe("Bearer bearer-s1");
	});

	test("a hook refusal is resent once with a renewed bearer; a second refusal fails", async () => {
		const h = harness();
		h.resumes.push(session("s1"), session("s1", "bearer-2"));
		h.routes.push(
			() => refused(),
			() => ({ status: 200, body: {} }),
		);
		expect((await h.fetch("/image/queue", { method: "POST" })).status).toBe(200);
		expect(h.sent.map((r) => r.headers.get("authorization"))).toEqual([
			"Bearer bearer-s1",
			"Bearer bearer-2",
		]);
		h.resumes.push(session("s1", "bearer-3"));
		h.routes.push(
			() => refused(),
			() => refused(),
		);
		await expect(h.fetch("/image/queue", { method: "POST" })).rejects.toBeInstanceOf(TypeError);
		expect(h.client.bound()?.sessionId).toBe("s1");
	});

	test("a route's own 401 is final", async () => {
		const h = harness();
		h.resumes.push(session("s1"));
		h.routes.push(() => ({ status: 401, body: { error: "unauthorized" } }));
		expect((await h.fetch("/video/queue", { method: "POST" })).status).toBe(401);
		expect(h.sent).toHaveLength(1);
	});

	test("another session ID reloads; a data request loads its target instead and waits", async () => {
		const h = harness();
		h.resumes.push(session("s1"));
		await h.fetch("/jobs/__data.json");
		h.resumes.push(session("s2"));
		h.routes.push(() => refused());
		await expect(h.fetch("/image/review", { method: "POST" })).rejects.toBeInstanceOf(TypeError);
		expect(h.navigations).toEqual(["reload"]);
		// The document is going: later requests wait for the unload instead of failing.
		expect(await settled(h.fetch("/jobs/__data.json"))).toBe("pending");
		const other = harness();
		other.resumes.push(session("s1"));
		await other.fetch("/jobs/__data.json");
		other.resumes.push(session("s2"));
		other.routes.push(() => refused());
		expect(await settled(other.fetch("/gallery/__data.json?x-sveltekit-invalidated=01"))).toBe(
			"pending",
		);
		expect(other.navigations).toEqual([`assign ${origin}/gallery`]);
	});

	test("session gone: an action gets the redirect unsent, sign-in data goes bare, others navigate", async () => {
		const h = harness();
		h.resumes.push(session("s1"));
		await h.fetch("/jobs/__data.json");
		h.resumes.push({ status: 401, body: { message: "Gone", location: "/sign-in" } });
		h.routes.push(() => refused());
		const action = await h.fetch("/settings/files", {
			method: "POST",
			headers: { "x-sveltekit-action": "true" },
		});
		expect(await action.json()).toEqual({ type: "redirect", status: 303, location: "/sign-in" });
		expect(h.sent).toHaveLength(2);
		expect(h.client.mode).toBe("signed-out");
		// A signed-out tab fails private requests and sends sign-in data without a bearer.
		await expect(h.fetch("/jobs/__data.json")).rejects.toBeInstanceOf(TypeError);
		await h.fetch("/sign-in/__data.json");
		expect(h.sent.at(-1)?.headers.has("authorization")).toBe(false);
		const plain = harness();
		plain.resumes.push({ status: 401, body: { message: "Gone", location: "/setup" } });
		expect(await settled(plain.fetch("/settings/files/state"))).toBe("pending");
		expect(plain.navigations).toEqual(["assign /setup"]);
	});

	test("a second 403 or a failure fails the request and keeps the tab bound", async () => {
		const h = harness();
		h.resumes.push(session("s1"));
		await h.fetch("/jobs/__data.json");
		h.routes.push(() => refused());
		h.resumes.push({ status: 403 }, { status: 403 });
		await expect(h.fetch("/jobs/__data.json")).rejects.toBeInstanceOf(TypeError);
		expect(h.client.bound()?.sessionId).toBe("s1");
		// Sign-in data still goes out, without a bearer.
		const cold = harness();
		cold.resumes.push({ status: 429 });
		expect((await cold.fetch("/sign-in/__data.json")).status).toBe(200);
		expect(cold.sent[0].headers.has("authorization")).toBe(false);
	});

	test("an access error answers with the access body, or an action error", async () => {
		const h = harness();
		h.resumes.push({ status: 503, body: access });
		const data = await h.fetch("/jobs/__data.json");
		expect([data.status, await data.json()]).toEqual([503, access]);
		h.resumes.push({ status: 503, body: access });
		const action = await h.fetch("/jobs", {
			method: "POST",
			headers: { "x-sveltekit-action": "true" },
		});
		expect(await action.json()).toEqual({ type: "error", error: access });
	});

	test("a request pinned to an earlier session sends nothing", async () => {
		const h = harness();
		h.resumes.push(session("s1"));
		await h.fetch("/jobs/__data.json");
		await expect(
			h.fetch("/image/files/draft", { method: "DELETE", siluetSession: "s0" } as RequestInit),
		).rejects.toBeInstanceOf(TypeError);
		expect(h.sent).toHaveLength(1);
	});

	test("the caller's own abort passes through", async () => {
		const h = harness();
		h.resumes.push(session("s1"));
		await h.fetch("/jobs/__data.json");
		h.routes.push(() => {
			throw new DOMException("Stopped", "AbortError");
		});
		await expect(h.fetch("/jobs/__data.json")).rejects.toMatchObject({ name: "AbortError" });
	});

	test("a Security response's bearer header is stripped before the form sees it", async () => {
		const h = harness();
		h.resumes.push(session("s1"));
		await h.fetch("/jobs/__data.json");
		h.routes.push(() => ({
			status: 200,
			body: { type: "success" },
			headers: { "x-siluet-bearer": "successor" },
		}));
		h.client.beginSecurity();
		const response = await h.fetch("/settings/security", {
			method: "POST",
			headers: { "x-sveltekit-action": "true" },
		});
		expect(response.headers.has("x-siluet-bearer")).toBe(false);
		expect(h.client.settleSecurity({ sessionId: "s2", codes: ["c"] }, true, page.href)).toBe(true);
		expect(h.client.bound()?.sessionId).toBe("s2");
		expect(h.client.liveBearer()).toBe("successor");
	});
});

describe("other tabs and requests", () => {
	test("a keyless tab sends no bearer and follows the hook's location", async () => {
		const h = harness({ stored: null });
		h.routes.push(() => refused(false));
		expect(await settled(h.fetch("/jobs/__data.json"))).toBe("pending");
		expect(h.sent[0].headers.has("authorization")).toBe(false);
		expect(h.navigations).toEqual(["assign /sign-in"]);
	});

	test("other origins and signed owner endpoints pass through without a bearer", async () => {
		const h = harness();
		await h.fetch("https://example.com/x");
		await h.fetch("/owner/sign-in", { method: "POST", body: "{}" });
		expect(h.sent.map((r) => r.headers.has("authorization"))).toEqual([false, false]);
		expect(h.client.mode).toBe("cold");
	});
});
