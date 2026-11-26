import type { KeyPurpose } from "./key-message";
import {
	type BrowserKey,
	type commitKey,
	type createCandidate,
	KeyUnavailable,
	type readBase,
	type readKey,
	signWith,
} from "./key-store";
import type { NoticeKind } from "./notices";

/**
 * One tab's claim or sign-in with a new candidate key ([key rotation](../../../../docs/SPEC-browser-key.md)).
 * The candidate, the base it replaces and the submitted fields live only in this tab's memory;
 * the candidate replaces the stored key only once its session is issued and the
 * compare-and-swap commit succeeds.
 */
export type Issued = { bearer: string; sessionId: string; loginId: string };
export type AttemptView = {
	/** The code step, while a pending proof waits. */
	factor: boolean;
	busy: boolean;
	/** Retry is offered; the credential inputs stay disabled meanwhile. */
	retry: boolean;
	message: string | null;
};
type Fields = Record<string, string>;
type Attempt = {
	kind: "claim" | "sign-in";
	candidate: BrowserKey;
	base: BrowserKey | null;
	/** The stored SPKI the commit expects to replace. */
	expected: string | null;
	/** The fields of the request in flight or offered for Retry. */
	fields: Fields | null;
	proof: string | null;
	/** An answer was lost: the server may have issued the candidate a session. */
	lost: boolean;
};
type Answer =
	| { kind: "session"; issued: Issued }
	| { kind: "proof"; proof: string }
	| { kind: "cancelled" }
	| { kind: "refused"; reason: string | null; message: string }
	| { kind: "retry"; message: string }
	| { kind: "recovery"; message: string }
	| { kind: "invalid"; message: string }
	| { kind: "lost" };
export type Resumed = { kind: "session"; issued: Issued } | { kind: "gone" } | Answer;

const restartedKey = "siluet-sign-in-pending";
const failed = "The studio could not complete the request. Retry.";
const restarted = "Sign-in restarted. Enter your username and password again.";

/** A reload or another document while a factor step waits shows "Sign-in restarted". */
export function markPendingSignIn(waiting: boolean) {
	try {
		if (waiting) sessionStorage.setItem(restartedKey, "1");
		else sessionStorage.removeItem(restartedKey);
	} catch {}
}
function takePendingSignIn() {
	try {
		const waiting = sessionStorage.getItem(restartedKey) !== null;
		sessionStorage.removeItem(restartedKey);
		return waiting;
	} catch {
		return false;
	}
}

const hex = async (text: string) =>
	Array.from(
		new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))),
		(byte) => byte.toString(16).padStart(2, "0"),
	).join("");

async function answerOf(response: Response | null): Promise<Answer> {
	if (!response) return { kind: "lost" };
	const body = await response.json().catch(() => undefined);
	const message = typeof body?.message === "string" ? body.message : failed;
	if (body && typeof body === "object" && "recoveryRequired" in body)
		return body.recoveryRequired === true || body.retry === false
			? { kind: "recovery", message }
			: { kind: "retry", message };
	if (response.ok) {
		if (
			typeof body?.bearer === "string" &&
			typeof body.sessionId === "string" &&
			typeof body.loginId === "string"
		)
			return {
				kind: "session",
				issued: { bearer: body.bearer, sessionId: body.sessionId, loginId: body.loginId },
			};
		if (typeof body?.proof === "string") return { kind: "proof", proof: body.proof };
		if (body?.cancelled === true) return { kind: "cancelled" };
		return { kind: "lost" };
	}
	if (response.status === 403 || response.status === 409)
		return {
			kind: "refused",
			reason: typeof body?.reason === "string" ? body.reason : null,
			message,
		};
	if (response.status === 429) return { kind: "retry", message };
	if (response.status === 400) return { kind: "invalid", message };
	return { kind: "lost" };
}

export function createSignInAttempts(owner: {
	installation: string | null;
	post(path: string, body: unknown): Promise<Response>;
	keys: {
		read: typeof readKey;
		base: typeof readBase;
		candidate: typeof createCandidate;
		commit: typeof commitKey;
	};
	/** A signed `resume` with this key. */
	resume(key: BrowserKey): Promise<Resumed>;
	/** Bind the committed session and tell other tabs. */
	bind(issued: Issued, kind: NoticeKind, key: BrowserKey): void;
	/** A document load of `url`. */
	open(url: string): void;
	/** Look for a stored-key change that waited for this tab's own request. */
	reconcile(): void;
	readonly leaving: boolean;
	/** The stored SPKI this tab last resumed or checked; undefined before its first read. */
	readonly lastSpki: string | null | undefined;
}) {
	let attempt: Attempt | null = null;
	/** Bumped on `pagehide`: steps of an earlier generation do nothing more. */
	let generation = 0;
	/** A stored-key change found while this tab's own request was in flight. */
	let deferred = false;
	/** What `pagehide` interrupted, for a back/forward-cache return. */
	let hidden: { proof: boolean } | null = null;
	const view: AttemptView = { factor: false, busy: false, retry: false, message: null };
	const listeners = new Set<(view: AttemptView) => void>();
	const changed = (patch: Partial<AttemptView>) => {
		Object.assign(view, patch);
		for (const listener of listeners) listener({ ...view });
	};
	const installation = () => {
		if (!owner.installation) throw new TypeError("Siluet could not identify this installation.");
		return owner.installation;
	};

	/** Drop the candidate, base and held fields; a pending proof goes with them. */
	function drop() {
		attempt = null;
		markPendingSignIn(false);
	}
	async function storedSpki() {
		return (await owner.keys.read(installation()).catch(() => null))?.spki ?? null;
	}

	async function send(step: "primary" | "factor" | "cancel"): Promise<Answer> {
		const current = attempt;
		if (!current) return { kind: "lost" };
		const purpose: KeyPurpose = step === "primary" ? current.kind : "factor";
		const path = `/owner/${purpose}`;
		const challenge = await owner.post("/owner/challenge", { purpose }).catch(() => null);
		if (!challenge?.ok) {
			const answer = await answerOf(challenge);
			return answer.kind === "lost" || answer.kind === "refused"
				? { kind: "retry", message: failed }
				: answer;
		}
		const { nonce } = await challenge.json();
		const proof = current.proof;
		const binding = step === "primary" ? "" : await hex(proof ?? "");
		const message = (binding: string) => ({
			purpose,
			origin: location.origin,
			installation: installation(),
			binding,
			nonce,
		});
		const body: Record<string, unknown> =
			step === "cancel"
				? { proof, cancel: true }
				: step === "factor"
					? { proof, ...current.fields }
					: { ...current.fields };
		body.key = current.candidate.spki;
		body.nonce = nonce;
		body.signature = await signWith(current.candidate, message(binding));
		// Cancel retires nothing, so it names no base.
		if (current.base && current.kind === "sign-in" && step !== "cancel")
			body.replaces = {
				key: current.base.spki,
				signature: await signWith(current.base, message(`replaces:${current.candidate.spki}`)),
			};
		return answerOf(await owner.post(path, body).catch(() => null));
	}

	/** Best-effort sign-out of a session the candidate will never store. */
	async function abandon(key: BrowserKey, loginId: string) {
		try {
			const challenge = await owner.post("/owner/challenge", { purpose: "sign-out" });
			if (!challenge.ok) return;
			const { nonce } = await challenge.json();
			const signature = await signWith(key, {
				purpose: "sign-out",
				origin: location.origin,
				installation: installation(),
				binding: loginId,
				nonce,
			});
			await owner.post("/owner/sign-out", { key: key.spki, loginId, nonce, signature });
		} catch {}
	}

	/** Another tab stored a key: drop both and load `/`, which joins a live session if any. */
	async function joinStored(current: Attempt) {
		attempt = null;
		if (current.lost) {
			const resumed = await owner.resume(current.candidate).catch(() => null);
			if (resumed?.kind === "session") await abandon(current.candidate, resumed.issued.loginId);
		}
		// The pending marker stays, so `/sign-in` says "Sign-in restarted" if no session is joined.
		owner.open("/");
		return null;
	}

	async function commit(current: Attempt, issued: Issued, alive: () => boolean) {
		if (!alive()) return null;
		let stored: boolean | null;
		try {
			stored = await owner.keys.commit(installation(), current.candidate, current.expected);
		} catch {
			stored = null;
		}
		// A `pagehide` during the write: the return re-reads the stored key instead.
		if (!alive()) return null;
		if (stored === null) {
			await abandon(current.candidate, issued.loginId);
			drop();
			changed({ factor: false, retry: false, message: new KeyUnavailable().message });
			return null;
		}
		if (!stored) {
			await abandon(current.candidate, issued.loginId);
			attempt = null;
			owner.open("/");
			return null;
		}
		drop();
		owner.bind(
			issued,
			current.kind === "claim" ? "claim" : current.proof ? "factor" : "sign-in",
			current.candidate,
		);
		changed({ factor: false, retry: false, message: null });
		return current.kind === "claim" ? "/settings/security?offer" : "/";
	}

	/** A refusal, mapped the same for a first answer and a resend. */
	function refuse(current: Attempt, answer: Answer & { kind: "refused" }) {
		if (answer.reason === "invalid-code" && current.proof) {
			current.fields = null;
			changed({ retry: false, message: answer.message });
			return null;
		}
		const factor = current.proof !== null;
		drop();
		changed({ factor: false, retry: false, message: factor ? restarted : answer.message });
		return null;
	}

	async function settle(
		current: Attempt,
		answer: Answer,
		resend: boolean,
		alive: () => boolean,
	): Promise<string | null> {
		if (!alive()) return null;
		switch (answer.kind) {
			case "session":
				return commit(current, answer.issued, alive);
			case "proof":
				current.proof = answer.proof;
				current.fields = null;
				markPendingSignIn(true);
				changed({ factor: true, retry: false, message: null });
				return null;
			case "cancelled":
				drop();
				changed({ factor: false, retry: false, message: null });
				return null;
			case "refused": {
				if (!resend) return refuse(current, answer);
				// The original may have committed after all: resume once more before refusing.
				const resumed = await owner.resume(current.candidate).catch(() => null);
				if (!alive()) return null;
				if (resumed?.kind === "session") return commit(current, resumed.issued, alive);
				if (resumed?.kind === "gone") return refuse(current, answer);
				return offerRetry();
			}
			case "retry":
				return offerRetry(answer.message);
			case "recovery":
				drop();
				changed({ factor: false, retry: false, message: answer.message });
				return null;
			case "invalid":
				drop();
				changed({ factor: false, retry: false, message: answer.message });
				return null;
			case "lost":
				current.lost = true;
				// One automatic resend per request; a second lost answer offers Retry.
				return resend ? offerRetry() : recover(current, alive);
		}
	}
	function offerRetry(message = failed) {
		changed({ retry: true, message });
		return null;
	}

	/**
	 * After a lost answer, or on Retry: `resume` with the candidate first. A session means the
	 * request committed; a 401 alone is no proof it failed, so the held fields go once more.
	 */
	async function recover(current: Attempt, alive: () => boolean): Promise<string | null> {
		const resumed = await owner.resume(current.candidate).catch(() => null);
		if (!alive()) return null;
		if (resumed?.kind === "session") return commit(current, resumed.issued, alive);
		if (resumed?.kind === "recovery") return settle(current, resumed, false, alive);
		if (resumed?.kind !== "gone")
			return offerRetry(resumed?.kind === "retry" ? resumed.message : failed);
		const step = current.proof ? "factor" : "primary";
		return settle(current, await send(step), true, alive);
	}

	/** Run one step of this tab's own request; stored-key changes wait until it settles. */
	async function run(step: (alive: () => boolean) => Promise<string | null>, quiet = false) {
		if (view.busy) return null;
		const started = generation;
		const alive = () => generation === started && !owner.leaving;
		// A background check keeps what the form shows.
		changed(quiet ? { busy: true } : { busy: true, message: null });
		try {
			return await step(alive);
		} catch (error) {
			if (alive()) {
				if (error instanceof KeyUnavailable) drop();
				changed({ message: error instanceof KeyUnavailable ? error.message : failed });
			}
			return null;
		} finally {
			if (generation === started) changed({ busy: false });
			if (deferred && generation === started) {
				deferred = false;
				owner.reconcile();
			}
		}
	}
	/** Before a retry or factor step: has another tab stored a key since the first read? */
	async function moved(current: Attempt) {
		return (await storedSpki()) !== current.expected;
	}

	/** A notice or check found a stored-key change: act on it once this tab's request settles. */
	async function storedKeyChanged() {
		if (view.busy) {
			deferred = true;
			return;
		}
		await run(async () => {
			const current = attempt;
			if (current && (await moved(current)) && attempt === current) await joinStored(current);
			return null;
		}, true);
	}

	return {
		subscribe(listener: (view: AttemptView) => void) {
			listeners.add(listener);
			listener({ ...view });
			return () => listeners.delete(listener);
		},
		/** The candidate this tab holds, if any. */
		get holding() {
			return attempt !== null || view.busy;
		},
		/** For tests: what the attempt holds, naming its fields without their values. */
		get held() {
			return (
				attempt && {
					candidate: attempt.candidate.spki,
					base: attempt.base?.spki ?? null,
					fields: attempt.fields && Object.keys(attempt.fields),
					proof: attempt.proof !== null,
				}
			);
		},
		/** A sign-in page shows "Sign-in restarted" after a reload during a factor step. */
		mount(claim: boolean) {
			if (!claim && takePendingSignIn()) changed({ message: restarted });
		},
		/** Claim or the primary sign-in, with a new candidate. Resolves to the destination on commit. */
		submit(kind: "claim" | "sign-in", fields: Fields) {
			return run(async (alive) => {
				drop();
				const { expected, base } = await owner.keys
					.base(installation())
					.catch(() => Promise.reject(new KeyUnavailable()));
				if (!alive()) return null;
				// Another tab stored a key since this tab last read one: join it instead.
				if (owner.lastSpki !== undefined && expected !== owner.lastSpki) {
					owner.open("/");
					return null;
				}
				const candidate = await owner.keys.candidate(installation());
				if (!alive()) return null;
				const current: Attempt = {
					kind,
					candidate,
					base: kind === "sign-in" ? base : null,
					expected,
					fields,
					proof: null,
					lost: false,
				};
				attempt = current;
				changed({ retry: false });
				return settle(current, await send("primary"), false, alive);
			});
		},
		/** The factor step for the pending proof, on the sign-in's candidate and base. */
		factor(code: string) {
			return run(async (alive) => {
				const current = attempt;
				if (!current?.proof) {
					changed({ factor: false, message: restarted });
					return null;
				}
				if (await moved(current)) return joinStored(current);
				if (!alive()) return null;
				current.fields = { code };
				return settle(current, await send("factor"), false, alive);
			});
		},
		/** Cancel the pending proof: no `replaces`, nothing retired, both dropped. */
		cancel() {
			return run(async (alive) => {
				const current = attempt;
				if (current?.proof) await send("cancel");
				if (!alive()) return null;
				drop();
				changed({ factor: false, retry: false, message: null });
				return null;
			});
		},
		/** Retry: resume with the candidate first, resending the held fields only on a 401. */
		retry() {
			return run(async (alive) => {
				const current = attempt;
				if (!current) {
					changed({ retry: false, factor: false });
					return null;
				}
				if (await moved(current)) return joinStored(current);
				if (!alive()) return null;
				changed({ retry: false });
				return recover(current, alive);
			});
		},
		storedKeyChanged,
		/** `pagehide`: later steps of the attempt do nothing; its candidate and fields go. */
		pagehide() {
			if (!attempt && !view.busy) return;
			hidden = { proof: attempt?.proof != null };
			generation++;
			deferred = false;
			attempt = null;
		},
		/**
		 * A back/forward-cache return: the form is back at its first step. True when a factor proof
		 * was pending, so the caller shows "Sign-in restarted" unless a live session was joined.
		 */
		pageshow() {
			const was = hidden;
			hidden = null;
			if (!was) return false;
			markPendingSignIn(false);
			changed({ factor: false, busy: false, retry: false, message: null });
			return was.proof;
		},
		restarted() {
			changed({ message: restarted });
		},
	};
}
export type SignInAttempts = ReturnType<typeof createSignInAttempts>;
