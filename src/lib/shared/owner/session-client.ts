import type { KeyPurpose } from "./key-message";
import {
	type BrowserKey,
	commitKey,
	createCandidate,
	readBase,
	readKey,
	signWith,
} from "./key-store";
import { createNotices, type NoticeKind } from "./notices";
import {
	createSignInAttempts,
	type Issued,
	markPendingSignIn,
	type Resumed,
} from "./sign-in-attempt";

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
	/** Answered for a session the tab has since left; nothing applies. */
	| { kind: "stale" }
	| { kind: "access"; status: number; body: AccessBody };
/** The bound session and remount generation when a check or renewal started. */
type Start = { sessionId: string | undefined; generation: number };
type Renewal = (
	| ({ kind: "session"; bearer: string } & Ids)
	| { kind: "gone"; location: string }
	| { kind: "failure" }
	| { kind: "access"; status: number; body: AccessBody }
) & { start?: Start };

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
/** Set before a document load that should offer to sign out the session it joins. */
const signOutOfferKey = "siluet-sign-out-offer";
function takeSignOutOffer() {
	try {
		const value = sessionStorage.getItem(signOutOfferKey);
		sessionStorage.removeItem(signOutOfferKey);
		return value;
	} catch {
		return null;
	}
}

export function createSessionClient(
	installation: string | null,
	nativeFetch: typeof fetch,
	browser: { assign(url: string): void; reload(): void; replace(url: string): void } = location,
	keys: {
		read: typeof readKey;
		base: typeof readBase;
		candidate: typeof createCandidate;
		commit: typeof commitKey;
	} = { read: readKey, base: readBase, candidate: createCandidate, commit: commitKey },
) {
	/** Set once this client starts a document load; requests then wait for the unload. */
	let leaving = false;
	/** Hidden while leaving: a back/forward-cache restore of this page is one the tab had left. */
	let abandoned = false;
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
	/** The stored SPKI this tab last resumed or checked; undefined before its first read. */
	let lastSpki: string | null | undefined;
	const noteKey = (key: BrowserKey | null) => {
		lastSpki = key?.spki ?? null;
		return key;
	};
	/** The fresh session a sign-out offer names, from the document load that set it. */
	let signOutOffer = takeSignOutOffer();
	/** Set while a sign-out's 409 check runs: a document load it starts carries the offer. */
	let offerOnLoad = false;
	/** `held` keeps codes on screen until Done; a document load is `leaving` instead. */
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
	/** A document load waiting for Done or a back/forward-cache return. Higher priority wins. */
	let destination: { url: string; priority: number } | null = null;
	let codesFrom: { url: string; offer: boolean } | null = null;
	const state: ClientState = { remountKey: 0, codes: null };
	/** Set once a recovery-required answer dropped the drafts; a later answer drops nothing more. */
	let recovering = false;
	function dropForRecovery() {
		if (recovering) return;
		recovering = true;
		state.remountKey++;
		changed();
	}
	const listeners = new Set<(state: ClientState) => void>();
	const changed = () => {
		for (const listener of listeners) listener({ ...state });
	};
	const notices = installation
		? createNotices(installation, (notice) => {
				if (notice.sessionId !== null && notice.sessionId === bound?.sessionId) return;
				// `/sign-in`, `/setup` and the codes hold never reload: they look for a new stored key.
				if (isPublicPath(location.pathname) || mode === "held") {
					if (document.visibilityState !== "hidden") void reconcile();
					return;
				}
				if (document.visibilityState === "hidden") {
					if (bearer) previous = bearer.value;
					bearer = null;
					// A check already in flight may answer for the old session: run it once more,
					// or, if it ends while the tab is still hidden, check afresh on return.
					if (checking) recheck = true;
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
			const start = started();
			try {
				return { ...(await resume()), start };
			} catch {
				return { kind: "failure" };
			} finally {
				renewal = null;
			}
		})();
		return renewal;
	}
	const storedKey = async () =>
		installation ? await keys.read(installation).catch(() => null) : null;
	/**
	 * One signed `resume` with the stored key. "Session gone" from a key no longer stored (another
	 * tab rotated it meanwhile) resumes once more with the stored one.
	 */
	async function resume(): Promise<Renewal> {
		const key = noteKey(await storedKey());
		if (!key) return { kind: "gone", location: "/sign-in" };
		const result = await resumeKey(key, previous);
		if (result.kind !== "gone") return result;
		const stored = await storedKey();
		if (!stored || stored.spki === key.spki) return result;
		noteKey(stored);
		return resumeKey(stored, previous);
	}
	/** A signed `resume` with `key`; a 403 retries once with a fresh challenge. */
	async function resumeKey(key: BrowserKey, retired: string | null): Promise<Renewal> {
		for (let attempt = 0; attempt < 2; attempt++) {
			const signedFields = await sign("resume", key, key.spki);
			const response = signedFields.fields
				? await post("/owner/resume", {
						...signedFields.fields,
						previous: retired ?? undefined,
					})
				: signedFields.challenge;
			const body = await readBody(response);
			if (response.ok && signedFields.fields) {
				if (retired !== null && retired === previous) previous = null;
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
	}
	const started = (): Start => ({ sessionId: bound?.sessionId, generation: state.remountKey });
	/**
	 * A result is stale when the tab has moved since its check or renewal started and the result
	 * does not name where it is now: say a Security change adopted its successor meanwhile.
	 */
	function isStale(result: Renewal) {
		const start = result.start;
		if (!start || (start.sessionId === bound?.sessionId && start.generation === state.remountKey))
			return false;
		if (result.kind === "session") return result.sessionId !== bound?.sessionId;
		// An access error for a session the tab has since left says nothing about where it is now.
		// A remount alone does not count: a shared renewal's first caller may have caused it.
		if (result.kind === "access") return start.sessionId !== bound?.sessionId;
		return result.kind === "gone" && bound !== null;
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
		if (isStale(result)) return { kind: "stale" };
		if (result.kind === "access") {
			if (result.body.recoveryRequired) dropForRecovery();
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
			recovering = false;
			// A load that joins a session ends any sign-in that was waiting for its code.
			if (mode !== "bound") markPendingSignIn(false);
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
		if (leaving || mode === "held" || (mode === "signed-out" && row.kind === "gone")) return;
		if (row.kind === "other") {
			bearer = null;
			if (offerOnLoad) offerSignOut(row.sessionId);
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

	/** No check runs while the tab loads or awaits another document, or has no session to check. */
	const settled = () =>
		leaving ||
		destination !== null ||
		mode === "held" ||
		mode === "keyless" ||
		mode === "signed-out";
	/**
	 * Check the tab's session. A tab coming back (`join`) shares a check already in flight; a
	 * notice or a stale answer asks for another pass, which a hidden tab leaves for its return.
	 */
	async function check(join = false) {
		if (installation && (isPublicPath(location.pathname) || mode === "held")) {
			await reconcile();
			return;
		}
		if (settled()) return;
		if (checking) {
			if (!join) recheck = true;
			return checking;
		}
		checking = (async () => {
			do {
				recheck = false;
				let row: Row | null = null;
				const live = liveBearer();
				const start = started();
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
								: await classify({ kind: "session", bearer: live, ...body, start });
					else if (response && isAccessBody(body))
						row = await classify({ kind: "access", status: response.status, body, start });
				}
				// An earlier pass may have started a document load or a hold.
				if (!row && settled()) return;
				row ??= await classify(await renew());
				if (row.kind === "other" || row.kind === "gone") leave(row, null);
				// A stale answer applies nothing; ask again where the tab is now.
				if (row.kind === "stale") recheck = true;
			} while (recheck && !settled() && document.visibilityState !== "hidden");
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

	function offerSignOut(sessionId: string) {
		try {
			sessionStorage.setItem(signOutOfferKey, sessionId);
		} catch {}
	}

	let reconciling: Promise<boolean> | null = null;
	let reconcileAgain = false;
	/**
	 * `/sign-in`, `/setup` and the codes hold: a stored key other than the one this tab last
	 * resumed or checked gets a signed `resume`. True when the tab loads `/` for its session.
	 */
	function reconcile(): Promise<boolean> {
		if (reconciling) {
			reconcileAgain = true;
			return reconciling;
		}
		reconciling = (async () => {
			let joined = false;
			do {
				reconcileAgain = false;
				if (leaving || !installation) break;
				// A tab holding its own candidate drops it for another tab's key.
				if (isPublicPath(location.pathname) && attempts.holding) {
					await attempts.storedKeyChanged();
					break;
				}
				const stored = await storedKey();
				if ((stored?.spki ?? null) === lastSpki) continue;
				noteKey(stored);
				if (!stored) continue;
				const result = await resumeKey(stored, null).catch((): Renewal => ({ kind: "failure" }));
				if (result.kind !== "session" || leaving) continue;
				if (mode === "held") joinedInHold();
				else if (isPublicPath(location.pathname)) {
					navigate.assign("/");
					joined = true;
				}
			} while (reconcileAgain);
			return joined;
		})().finally(() => {
			reconciling = null;
		});
		return reconciling;
	}
	/** The codes hold met the new key's live session: the codes changed, Done opens Security. */
	function joinedInHold() {
		if (state.codes && state.codes.notice !== "replaced")
			state.codes = { ...state.codes, notice: "changed" };
		if (destination?.url === "/sign-in")
			destination = { url: "/settings/security", priority: destination.priority };
		changed();
	}

	const attempts = createSignInAttempts({
		installation,
		post,
		keys,
		async resume(key): Promise<Resumed> {
			const result = await resumeKey(key, null);
			if (result.kind === "session")
				return {
					kind: "session",
					issued: { bearer: result.bearer, sessionId: result.sessionId, loginId: result.loginId },
				};
			if (result.kind === "gone") return { kind: "gone" };
			if (result.kind === "access")
				return result.body.recoveryRequired || !result.body.retry
					? { kind: "recovery", message: result.body.message }
					: { kind: "retry", message: result.body.message };
			return { kind: "lost" };
		},
		bind(issued: Issued, kind: NoticeKind, key: BrowserKey) {
			noteKey(key);
			bindLogin(issued, kind);
		},
		open: (url) => navigate.assign(url),
		reconcile: () => void reconcile(),
		get leaving() {
			return leaving;
		},
	});

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
				if (!noteKey(await storedKey())) {
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
		/**
		 * A recovery-required answer drops the drafts once per transition into recovery, so a
		 * page that refetches on mount cannot remount the studio again and again.
		 */
		recoveryRequired: dropForRecovery,
		/** A private answer that is not an access error: the host is out of recovery. */
		recovered() {
			recovering = false;
		},
		/**
		 * The hook refused `value`. Drop it if it is still the tab's bearer, keeping it as `previous`
		 * for the next resume; a bearer renewed meanwhile stays.
		 */
		refused(value: string) {
			if (bearer?.value !== value) return;
			previous = value;
			bearer = null;
		},

		/** Claim and sign-in with a new candidate key, on `/setup` and `/sign-in`. */
		attempts,
		/** On `/` bound to the session a sign-out offer names: show it once. */
		takeSignOutOffer() {
			const offered = signOutOffer;
			signOutOffer = null;
			return offered !== null && location.pathname === "/" && offered === bound?.sessionId;
		},

		/**
		 * Sign out this browser's current login. Results apply against the key and login ID taken
		 * when sign-out began; before success applies, a key stored since resumes instead.
		 */
		async signOut(): Promise<"signed-out" | "other" | "retry"> {
			const key = await storedKey();
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
			if (bound?.loginId !== login) return "retry";
			if (response?.ok) {
				const stored = await storedKey();
				if (stored && stored.spki !== key.spki) {
					// Another tab signed in with a new key: its result applies through the table.
					const row = await classify(await renew());
					if (row.kind === "other") {
						offerSignOut(row.sessionId);
						leave(row, new URL("/", location.href).href);
						return "other";
					}
					if (row.kind !== "gone") return "retry";
				}
				notices?.post("sign-out", null);
				leave({ kind: "gone", location: "/sign-in" }, null);
				return "signed-out";
			}
			if (response?.status === 409) {
				offerOnLoad = true;
				void check().finally(() => {
					offerOnLoad = false;
				});
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
			// An earlier change still pending releases its waiters before it is replaced.
			security?.settle();
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
			attempts.pagehide();
			abandoned = leaving;
			state.codes = null;
			codesFrom = null;
			changed();
		},
		/** The sole `pageshow` path: load a pending destination atomically and check nothing. */
		pageshow(persisted: boolean) {
			// A page restored from the back/forward cache was not replaced after all.
			const left = persisted && abandoned;
			abandoned = false;
			if (persisted) {
				leaving = false;
				signOutOffer = null;
				takeSignOutOffer();
			}
			// A return without the candidate: the sign-in restarts unless a live session is joined.
			if (attempts.pageshow() && !destination && !left) {
				void reconcile().then((joined) => {
					if (!joined) attempts.restarted();
				});
				return;
			}
			if (destination) {
				const url = new URL(destination.url, location.href).href;
				destination = null;
				if (url === location.href) navigate.reload();
				else navigate.replace(url);
				return;
			}
			// This tab had already left it for another session or sign-in: load it afresh.
			if (left) navigate.reload();
			else if (persisted) void check();
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
