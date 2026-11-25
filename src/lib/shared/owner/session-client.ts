import type { KeyPurpose } from "./key-message";
import { type BrowserKey, ensureKey, readKey, signWith } from "./key-store";
import { createNotices, type NoticeKind } from "./notices";

/**
 * One tab's view of the owner session ([browser key sessions](../../../../docs/SPEC-browser-key.md)).
 * The tab binds to a session ID on its first `resume` and holds short-lived bearers for it in
 * memory. Every result the server gives is classified into one row of the spec's table.
 */
export type Ids = { sessionId: string; loginId: string };
export type AccessBody = { message: string; retry: boolean; recoveryRequired: boolean };
/** What a renewal or check found, relative to the session the tab is bound to. */
export type Row =
	| { kind: "bound" }
	| ({ kind: "other" } & Ids)
	| { kind: "gone"; location: string }
	| { kind: "failure" }
	| { kind: "access"; status: number; body: AccessBody };
type Renewal =
	| ({ kind: "session"; bearer: string } & Ids)
	| { kind: "gone"; location: string }
	| { kind: "failure" }
	| { kind: "access"; status: number; body: AccessBody };

export type CodesNotice = "replaced" | "changed" | "signed-out" | null;
export type CodesView = { codes: string[]; notice: CodesNotice };
export type ClientState = {
	/** Bumped to drop drafts and other per-session state by remounting the studio. */
	remountKey: number;
	codes: CodesView | null;
};

/** A bearer lives ten minutes on the server; renew a little earlier. */
const bearerMs = 9 * 60000;
const isPublicPath = (path: string) => path === "/sign-in" || path === "/setup";
const isAccessBody = (value: unknown): value is AccessBody =>
	typeof value === "object" && value !== null && "recoveryRequired" in value;

export function createSessionClient(
	installation: string | null,
	nativeFetch: typeof fetch,
	browser: { assign(url: string): void; reload(): void; replace(url: string): void } = location,
	keys: { read: typeof readKey; ensure: typeof ensureKey } = { read: readKey, ensure: ensureKey },
) {
	/** Set once this client starts a document load; requests then wait for the unload. */
	let leaving = false;
	const navigate = {
		assign(url: string) {
			leaving = true;
			browser.assign(url);
		},
		reload() {
			leaving = true;
			browser.reload();
		},
		replace(url: string) {
			leaving = true;
			browser.replace(url);
		},
	};
	let record: BrowserKey | null | undefined;
	let mode: "cold" | "bound" | "keyless" | "signed-out" | "held" = "cold";
	let bound: Ids | null = null;
	let bearer: { value: string; sessionId: string; expires: number } | null = null;
	let previous: string | null = null;
	let renewal: Promise<Renewal> | null = null;
	let securityBearer: string | null = null;
	let security: {
		start: string;
		waited: Row[];
		settled: Promise<void>;
		settle: () => void;
	} | null = null;
	let checking: Promise<void> | null = null;
	let recheck = false;
	let checkWhenVisible = false;
	/** A document load waiting for Done or a back/forward-cache return. Higher priority wins. */
	let destination: { url: string; priority: number } | null = null;
	let codesFrom: { url: string; offer: boolean } | null = null;
	const state: ClientState = { remountKey: 0, codes: null };
	const listeners = new Set<(state: ClientState) => void>();
	const changed = () => {
		for (const listener of listeners) listener({ ...state });
	};
	const notices = installation
		? createNotices(installation, (notice) => {
				if (notice.sessionId !== null && notice.sessionId === bound?.sessionId) return;
				if (isPublicPath(location.pathname)) return;
				if (document.visibilityState === "hidden") {
					if (bearer) previous = bearer.value;
					bearer = null;
					checkWhenVisible = true;
				} else void check();
			})
		: null;

	const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
		nativeFetch(path, {
			method: "POST",
			credentials: "omit",
			headers: { "content-type": "application/json", ...headers },
			body: JSON.stringify(body),
		});
	async function sign(purpose: KeyPurpose, key: BrowserKey, binding: string) {
		if (!installation) throw new TypeError("Siluet could not identify this installation.");
		const challenge = await post("/owner/challenge", { purpose });
		if (!challenge.ok) return { challenge };
		const { nonce } = await challenge.json();
		const signature = await signWith(key, {
			purpose,
			origin: location.origin,
			installation,
			binding,
			nonce,
		});
		return { fields: { key: key.spki, nonce, signature } };
	}
	/** Spend a challenge on one signed request; a 403 retries once with a fresh one. */
	async function signed(
		purpose: KeyPurpose,
		path: string,
		key: BrowserKey,
		fields: Record<string, unknown>,
		binding: string,
		retry = false,
	): Promise<Response> {
		const signedFields = await sign(purpose, key, binding);
		if (!signedFields.fields) return signedFields.challenge;
		const response = await post(path, { ...fields, ...signedFields.fields });
		if (response.status === 403 && retry) return signed(purpose, path, key, fields, binding);
		return response;
	}
	async function readBody(response: Response) {
		return response.json().catch(() => null);
	}

	/** Single-flight `resume`, re-reading the key each time. */
	function renew(): Promise<Renewal> {
		renewal ??= (async (): Promise<Renewal> => {
			try {
				record = installation ? await keys.read(installation).catch(() => null) : null;
				if (!record) return { kind: "gone", location: "/sign-in" };
				const key = record;
				for (let attempt = 0; attempt < 2; attempt++) {
					const signedFields = await sign("resume", key, key.spki);
					const response = signedFields.fields
						? await post("/owner/resume", {
								...signedFields.fields,
								previous: previous ?? undefined,
							})
						: signedFields.challenge;
					const body = await readBody(response);
					if (response.ok && signedFields.fields) {
						previous = null;
						return { kind: "session", ...(body as Ids & { bearer: string }) };
					}
					if (isAccessBody(body)) return { kind: "access", status: response.status, body };
					if (response.status === 401 && signedFields.fields)
						return {
							kind: "gone",
							location: typeof body?.location === "string" ? body.location : "/sign-in",
						};
					if (response.status !== 403) return { kind: "failure" };
				}
				return { kind: "failure" };
			} catch {
				return { kind: "failure" };
			} finally {
				renewal = null;
			}
		})();
		return renewal;
	}

	function holdCodes(row: Row & { kind: "other" | "gone" }) {
		mode = "held";
		bearer = null;
		state.remountKey++;
		const url = row.kind === "other" ? "/settings/security" : row.location;
		if (!destination || destination.priority < 2) destination = { url, priority: 2 };
		if (state.codes)
			state.codes = {
				...state.codes,
				notice:
					row.kind === "gone"
						? "signed-out"
						: row.loginId === bound?.loginId
							? "replaced"
							: "changed",
			};
		changed();
	}

	/**
	 * Apply a renewal to the tab and classify it. While a Security change is pending, an
	 * "Other ID" or "Session gone" result waits for its response.
	 */
	async function classify(result: Renewal, wait = true): Promise<Row> {
		if (result.kind === "access") {
			if (result.body.recoveryRequired) {
				state.remountKey++;
				changed();
			}
			return result;
		}
		if (result.kind === "failure") return result;
		let row: Row =
			result.kind === "gone"
				? result
				: mode !== "bound" || result.sessionId === bound?.sessionId
					? { kind: "bound" }
					: { kind: "other", sessionId: result.sessionId, loginId: result.loginId };
		if (result.kind === "session" && row.kind === "bound" && mode !== "held") {
			mode = "bound";
			bound = { sessionId: result.sessionId, loginId: result.loginId };
			bearer = {
				value: result.bearer,
				sessionId: result.sessionId,
				expires: performance.now() + bearerMs,
			};
			return row;
		}
		if (row.kind === "bound") return { kind: "failure" };
		const pending = security;
		if (pending) {
			pending.waited.push(row);
			// The Security POST itself never waits; its caller fails it.
			if (!wait) return row;
			await pending.settled;
			if (row.kind === "other" && row.sessionId === bound?.sessionId && mode === "bound")
				return { kind: "bound" };
			row = pending.waited.at(-1) ?? row;
		}
		return row;
	}

	/**
	 * The tab-level effect of an "Other ID" or "Session gone" row. `navigateSelf` is false
	 * when the caller's own result (an action's redirect) navigates instead.
	 */
	function leave(
		row: Row & { kind: "other" | "gone" },
		target: string | null,
		navigateSelf = true,
	) {
		if (state.codes) return holdCodes(row);
		if (mode === "held" || (mode === "signed-out" && row.kind === "gone")) return;
		if (row.kind === "other") {
			mode = "held";
			bearer = null;
			if (target && target !== location.href) navigate.assign(target);
			else navigate.reload();
			return;
		}
		// A tab that held a session drops its drafts; a cold tab has none to drop.
		const held = mode === "bound";
		mode = "signed-out";
		bound = null;
		bearer = null;
		if (held) {
			state.remountKey++;
			changed();
		}
		if (navigateSelf && !isPublicPath(location.pathname)) navigate.assign(row.location);
	}

	async function check() {
		if (destination || mode === "held" || mode === "keyless" || mode === "signed-out") return;
		if (checking) {
			recheck = true;
			return checking;
		}
		checking = (async () => {
			do {
				recheck = false;
				let row: Row | null = null;
				const live = liveBearer();
				if (live && mode === "bound") {
					const response = await nativeFetch("/owner/session", {
						credentials: "omit",
						headers: { authorization: `Bearer ${live}` },
					}).catch(() => null);
					const body = response ? await readBody(response) : null;
					if (response?.ok && typeof body?.sessionId === "string")
						row =
							body.sessionId === bound?.sessionId
								? { kind: "bound" }
								: await classify({ kind: "session", bearer: live, ...body });
					else if (response && isAccessBody(body))
						row = await classify({ kind: "access", status: response.status, body });
				}
				row ??= await classify(await renew());
				if (row.kind === "other" || row.kind === "gone") leave(row, null);
				checkWhenVisible = row.kind === "failure";
			} while (recheck);
		})().finally(() => {
			checking = null;
		});
		return checking;
	}

	function liveBearer() {
		return bearer && bearer.expires > performance.now() && bearer.sessionId === bound?.sessionId
			? bearer.value
			: null;
	}

	function bindLogin(issued: Ids & { bearer: string }, kind: NoticeKind) {
		mode = "bound";
		bound = { sessionId: issued.sessionId, loginId: issued.loginId };
		bearer = {
			value: issued.bearer,
			sessionId: issued.sessionId,
			expires: performance.now() + bearerMs,
		};
		previous = null;
		notices?.post(kind, issued.sessionId);
	}

	async function ownerKey() {
		if (!installation) throw new TypeError("Siluet could not identify this installation.");
		record = await keys.ensure(installation);
		return record;
	}

	return {
		subscribe(listener: (state: ClientState) => void) {
			listeners.add(listener);
			listener({ ...state });
			return () => listeners.delete(listener);
		},
		get mode() {
			return mode;
		},
		get leaving() {
			return leaving;
		},
		get remountKey() {
			return state.remountKey;
		},
		bound: () => bound,
		/** A document load of `url`, as the wrapper follows a hook's `location`. */
		open(url: string) {
			navigate.assign(url);
		},
		liveBearer,
		/** Make sure the tab knows whether it has a key, then bind a cold tab. */
		async prepare(): Promise<Row | null> {
			if (mode === "cold") {
				record = installation ? await keys.read(installation).catch(() => null) : null;
				if (!record) {
					mode = "keyless";
					return null;
				}
			}
			return null;
		},
		renew,
		classify,
		leave,
		check,
		/** Drop work tied to the current session: remount the studio. */
		dropDrafts() {
			state.remountKey++;
			changed();
		},
		visible() {
			if (checkWhenVisible) void check();
		},
		/** For a hidden tab: drop its bearer, keeping it as `previous` for the next resume. */
		hidden() {
			if (bearer) previous = bearer.value;
			bearer = null;
		},

		// Claim, sign-in, factor and sign-out post signed requests and bind the result.
		async claim(fields: { token: string; username: string; password: string }) {
			const response = await signed("claim", "/owner/claim", await ownerKey(), fields, "");
			const body = await readBody(response);
			if (response.ok) bindLogin(body, "claim");
			return { ok: response.ok, status: response.status, body };
		},
		async signIn(fields: { username: string; password: string }) {
			const response = await signed("sign-in", "/owner/sign-in", await ownerKey(), fields, "");
			const body = await readBody(response);
			if (response.ok && body?.bearer) bindLogin(body, "sign-in");
			return { ok: response.ok, status: response.status, body };
		},
		async factor(proof: string, fields: { code: string } | { cancel: true }) {
			const digest = Array.from(
				new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(proof))),
				(byte) => byte.toString(16).padStart(2, "0"),
			).join("");
			const response = await signed(
				"factor",
				"/owner/factor",
				await ownerKey(),
				{ proof, ...fields },
				digest,
			);
			const body = await readBody(response);
			if (response.ok && body?.bearer) bindLogin(body, "factor");
			return { ok: response.ok, status: response.status, body };
		},
		/**
		 * Sign out this browser's current login. The result applies only while the tab still
		 * holds that key and login ID.
		 */
		async signOut(): Promise<"signed-out" | "other" | "retry"> {
			const key = installation ? await keys.read(installation).catch(() => null) : null;
			const login = bound?.loginId;
			if (!key || !login) {
				leave({ kind: "gone", location: "/sign-in" }, null);
				return "signed-out";
			}
			const response = await signed(
				"sign-out",
				"/owner/sign-out",
				key,
				{ loginId: login },
				login,
				true,
			).catch(() => null);
			if (bound?.loginId !== login || record?.spki !== key.spki) return "retry";
			if (response?.ok) {
				notices?.post("sign-out", null);
				leave({ kind: "gone", location: "/sign-in" }, null);
				return "signed-out";
			}
			if (response?.status === 409) {
				void check();
				return "other";
			}
			return "retry";
		},

		// Security changes.
		/** Record the successor's bearer the wrapper stripped from a Security response. */
		stashSecurityBearer(value: string) {
			securityBearer = value;
		},
		beginSecurity() {
			const settle = Promise.withResolvers<void>();
			security = {
				start: bound?.sessionId ?? "",
				waited: [],
				settled: settle.promise,
				settle: settle.resolve,
			};
			securityBearer = null;
		},
		/**
		 * Settle a Security response. Codes go to the layer first; then the tab adopts the
		 * successor if it is still on the start session and no waited result disagrees.
		 * Returns true when the caller should apply the result with `update()`.
		 */
		settleSecurity(
			result: { sessionId: string; codes: string[] } | null,
			present: boolean,
			from: string,
		) {
			const pending = security;
			security = null;
			const successor = securityBearer;
			securityBearer = null;
			if (!pending) return false;
			pending.settle();
			const latest = pending.waited.at(-1);
			if (!result) {
				if (latest && (latest.kind === "other" || latest.kind === "gone")) leave(latest, null);
				return false;
			}
			if (present && result.codes.length) {
				state.codes = { codes: result.codes, notice: null };
				codesFrom = { url: from, offer: new URL(from).searchParams.has("offer") };
			}
			const adopt =
				present &&
				successor !== null &&
				mode === "bound" &&
				bound?.sessionId === pending.start &&
				(!latest || (latest.kind === "other" && latest.sessionId === result.sessionId));
			if (adopt && bound) {
				bound = { sessionId: result.sessionId, loginId: bound.loginId };
				bearer = {
					value: successor,
					sessionId: result.sessionId,
					expires: performance.now() + bearerMs,
				};
				pending.waited.length = 0;
				notices?.post("security", result.sessionId);
				state.remountKey++;
				changed();
				return true;
			}
			// Another tab or browser moved on: only the waited row applies. A response after the
			// owner left installs nothing but still tells other tabs and checks.
			if (!present) {
				notices?.post("security", null);
				void check();
			} else if (latest && (latest.kind === "other" || latest.kind === "gone")) leave(latest, null);
			changed();
			return false;
		},
		/** Done on the codes dialog: consume, then load, any destination. */
		done() {
			const pending = destination;
			const from = codesFrom;
			destination = null;
			codesFrom = null;
			state.codes = null;
			changed();
			if (pending) {
				const url = new URL(pending.url, location.href).href;
				if (url === location.href) navigate.reload();
				else navigate.replace(url);
				return null;
			}
			return from?.offer && location.href === from.url ? "/settings/files?offer" : null;
		},
		/** Register a lower-priority destination for a back/forward-cache return. */
		registerDestination(url: string) {
			if (!destination) destination = { url, priority: 1 };
		},
		get holding() {
			return mode === "held" && state.codes !== null;
		},
		/** `pagehide` clears codes and the hold; a pending destination waits for `pageshow`. */
		pagehide() {
			state.codes = null;
			codesFrom = null;
			changed();
		},
		/** The sole `pageshow` path: load a pending destination atomically and check nothing. */
		pageshow(persisted: boolean) {
			// A page restored from the back/forward cache was not replaced after all.
			if (persisted) leaving = false;
			if (destination) {
				const url = new URL(destination.url, location.href).href;
				destination = null;
				if (url === location.href) navigate.reload();
				else navigate.replace(url);
				return;
			}
			if (persisted) void check();
		},
	};
}
export type SessionClient = ReturnType<typeof createSessionClient>;

let current: SessionClient | null = null;
/** The page's session client, installed once by the client `init` hook. */
export function setSessionClient(client: SessionClient) {
	current = client;
}
export function sessionClient() {
	if (!current) throw new TypeError("The studio session is not ready.");
	return current;
}
