import type { Row, SessionClient } from "./session-client";

/**
 * Wrap the page's `fetch` so same-origin requests carry the tab's bearer and never cookies
 * ([browser key sessions](../../../../docs/SPEC-browser-key.md)). A request is pinned to the
 * session it was created under: it goes out, or is resent once after the hook refuses its
 * bearer, only with a bearer for that session. Wrapper failures are `TypeError`; the caller's
 * own `AbortError` passes through.
 */
export type SessionInit = RequestInit & {
	/** The session this request belongs to, captured when its draft or retry was created. */
	siluetSession?: string;
	__sveltekit_fetch__?: boolean;
};

const signedPaths = /^\/owner\/(?:challenge|claim|sign-in|factor|resume|sign-out)$/;
const dataSuffix = "/__data.json";
const fail = (message: string) => Promise.reject(new TypeError(message));
/** A promise that never settles: the wrapper navigates, or defers to the codes dialog. */
const pending = () => new Promise<Response>(() => {});
const jsonResponse = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const hookRefusal = (response: Response) =>
	response.status === 401 && (response.headers.get("www-authenticate") ?? "").startsWith("Bearer");

export function authenticatedFetch(client: SessionClient, native: typeof fetch) {
	return function fetchWithSession(
		input: RequestInfo | URL,
		init: SessionInit = {},
	): Promise<Response> {
		const request = input instanceof Request ? input : null;
		const url = new URL(request ? request.url : String(input), location.href);
		if (url.origin !== location.origin) return native(input, init);
		const method = (init.method ?? request?.method ?? "GET").toUpperCase();
		const { siluetSession, ...forwarded } = init;
		// The document is being replaced; nothing more goes out from this page.
		if (client.leaving) return pending();
		if (method === "POST" && signedPaths.test(url.pathname))
			return native(input, { ...forwarded, credentials: "omit" });

		const data = url.pathname.endsWith(dataSuffix);
		const page = data ? url.pathname.slice(0, -dataSuffix.length) || "/" : url.pathname;
		const headers = new Headers(forwarded.headers ?? request?.headers);
		const action = method === "POST" && headers.get("x-sveltekit-action") === "true";
		const publicData = data && (page === "/sign-in" || page === "/setup");
		const securityPost = action && page === "/settings/security";
		// The document a data request is loading, for a full load in its place.
		const target = () => {
			const href = new URL(url);
			href.pathname = page;
			for (const key of [...href.searchParams.keys()])
				if (key.startsWith("x-sveltekit-")) href.searchParams.delete(key);
			return href.href;
		};
		// Captured now, before any renewal or wait.
		const pinned = siluetSession ?? client.bound()?.sessionId ?? null;

		function send(bearer: string | null) {
			const sent = client.remountKey;
			const outgoing = new Headers(headers);
			if (bearer) outgoing.set("authorization", `Bearer ${bearer}`);
			else outgoing.delete("authorization");
			const options = { ...forwarded, headers: outgoing, credentials: "omit" as const };
			return native(request ? new Request(request, options) : input, options).then((response) => {
				// A response from before a remount applies nothing. A Security response always
				// reaches its settlement, which decides for itself.
				if (client.remountKey !== sent && !securityPost)
					throw new DOMException("The studio changed session.", "AbortError");
				const successor = response.headers.get("x-siluet-bearer");
				if (successor === null) return response;
				client.stashSecurityBearer(successor);
				const kept = new Headers(response.headers);
				kept.delete("x-siluet-bearer");
				return new Response(response.body, {
					status: response.status,
					statusText: response.statusText,
					headers: kept,
				});
			});
		}

		/** What a pinned request does for a row other than its own session. */
		function settle(row: Row): Promise<Response> {
			switch (row.kind) {
				case "other":
					if (data) {
						client.leave(row, target());
						return pending();
					}
					client.leave(row, null);
					return fail("The studio's session changed.");
				case "gone":
					if (action) {
						client.leave(row, null, false);
						return Promise.resolve(
							jsonResponse({ type: "redirect", status: 303, location: row.location }),
						);
					}
					if (publicData) {
						client.leave(row, null, false);
						return send(null);
					}
					client.leave(row, null);
					return pending();
				case "access":
					return Promise.resolve(
						jsonResponse(action ? { type: "error", error: row.body } : row.body, row.status),
					);
				default:
					return publicData ? send(null) : fail("The studio is unavailable. Retry.");
			}
		}

		async function renewed(): Promise<{ bearer: string } | { row: Row }> {
			const row = await client.classify(await client.renew(), !securityPost);
			if (row.kind !== "bound") {
				// The Security POST fails at once; its settlement applies what it met.
				if (securityPost && (row.kind === "other" || row.kind === "gone"))
					return { row: { kind: "failure" } };
				return { row };
			}
			const bearer = client.liveBearer();
			if (!bearer || (pinned !== null && client.bound()?.sessionId !== pinned))
				return { row: { kind: "failure" } };
			return { bearer };
		}

		async function keyed(first: string | null): Promise<Response> {
			let bearer = first;
			for (let attempt = 0; ; attempt++) {
				if (!bearer) {
					const next = await renewed();
					if ("row" in next) return settle(next.row);
					bearer = next.bearer;
				}
				const response = await send(bearer);
				if (!hookRefusal(response) || publicData) return response;
				// A route's own 401 is final; only the hook's invalid_token is resent, once.
				if (!(response.headers.get("www-authenticate") ?? "").includes("invalid_token"))
					return response;
				if (attempt > 0) throw new TypeError("The studio refused this session.");
				client.hidden();
				bearer = null;
			}
		}

		async function keyless(): Promise<Response> {
			const response = await send(null);
			if (!hookRefusal(response) || action || publicData) return response;
			const body = await response
				.clone()
				.json()
				.catch(() => null);
			if (typeof body?.location === "string" && location.pathname !== body.location) {
				client.open(body.location);
				return pending();
			}
			return response;
		}

		// A live bearer sends synchronously, so a `pagehide` keepalive request still leaves.
		const live = client.liveBearer();
		if (
			client.mode === "bound" &&
			live &&
			(pinned === null || pinned === client.bound()?.sessionId)
		)
			return keyed(live);
		if (client.mode === "held") return pending();
		return (async () => {
			await client.prepare();
			if (client.mode === "keyless") return keyless();
			if (client.mode === "signed-out")
				return publicData ? send(null) : fail("Sign in to open the studio.");
			if (pinned !== null && client.bound() && client.bound()?.sessionId !== pinned)
				return fail("This request belongs to an earlier session.");
			return keyed(client.liveBearer());
		})();
	};
}
