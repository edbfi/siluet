import { expect, test } from "bun:test";
import { toBase64Url } from "./key-message";
import type { BrowserKey } from "./key-store";
import { createSessionClient } from "./session-client";

// Key rotation at claim and sign-in ([browser key sessions](../../../../docs/SPEC-browser-key.md)),
// against a scripted studio. Each answer is queued per endpoint; "network" loses it.
const origin = "http://127.0.0.1:4000";
const installation = "7d4f3f0e-2a1b-4c5d-8e9f-0a1b2c3d4e5f";
const page = { href: `${origin}/sign-in`, pathname: "/sign-in" };
const storage = new Map<string, string>();
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
	sessionStorage: {
		getItem: (key: string) => storage.get(key) ?? null,
		setItem: (key: string, value: string) => storage.set(key, value),
		removeItem: (key: string) => storage.delete(key),
	},
});
const at = (path: string) => {
	page.pathname = path;
	page.href = `${origin}${path}`;
};

async function newKey(): Promise<BrowserKey> {
	const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, [
		"sign",
		"verify",
	]);
	return {
		key: pair.privateKey,
		spki: toBase64Url(new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey))),
	};
}

type Answer = { status: number; body?: unknown } | "network";
type Script =
	| Answer
	| Promise<Answer>
	| ((body: Record<string, unknown>) => Answer | Promise<Answer>);
const session = (sessionId: string, loginId = `login-${sessionId}`): Answer => ({
	status: 200,
	body: { bearer: `bearer-${sessionId}`, sessionId, loginId },
});
const proof = (value = "proof-1"): Answer => ({ status: 200, body: { proof: value } });
const refused = (reason?: string, status = 403): Answer => ({
	status,
	body: reason ? { message: `Refused: ${reason}`, reason } : { message: "Refused." },
});
const gone: Answer = { status: 401, body: { message: "Gone.", location: "/sign-in" } };

async function harness({
	stored = null as BrowserKey | null,
	/** False stores a record that cannot sign a test message: no base. */
	signing = true,
	path = "/sign-in",
	/** Keep sessionStorage, as the next document of the same tab does. */
	reload = false,
} = {}) {
	at(path);
	if (!reload) storage.clear();
	const store = {
		record: stored,
		failCommit: false,
		/** Holds the write once it began, as a transaction under way. */
		hold: null as Promise<void> | null,
		/** Holds a read of the stored record. */
		readHold: null as Promise<void> | null,
		/** Reads of the stored record begun so far. */
		reads: 0,
	};
	const scripts = new Map<string, Script[]>();
	const sent: { path: string; body: Record<string, unknown> }[] = [];
	const navigations: string[] = [];
	const events: string[] = [];
	const candidates: BrowserKey[] = [];
	const native = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const path = new URL(String(input), origin).pathname;
		const body = init?.body ? JSON.parse(String(init.body)) : {};
		if (path === "/owner/challenge")
			return new Response(JSON.stringify({ nonce: `nonce-${sent.length}` }));
		sent.push({ path, body });
		const queued = scripts.get(path)?.shift();
		const answer = await (typeof queued === "function"
			? queued(body)
			: (queued ?? (path === "/owner/resume" ? gone : { status: 500 })));
		if (answer === "network") throw new TypeError("Failed to fetch");
		return new Response(JSON.stringify(answer.body ?? null), { status: answer.status });
	}) as typeof fetch;
	const client = createSessionClient(
		installation,
		native,
		{
			assign: (url) => navigations.push(`assign ${url}`),
			reload: () => navigations.push("reload"),
			replace: (url) => navigations.push(`replace ${url}`),
		},
		{
			async read() {
				store.reads++;
				await store.readHold;
				return store.record;
			},
			base: async () => ({
				expected: store.record?.spki ?? null,
				base: signing ? store.record : null,
			}),
			async candidate() {
				const key = await newKey();
				candidates.push(key);
				return key;
			},
			async commit(_installation, candidate, expected) {
				events.push("commit");
				await store.hold;
				if (store.failCommit) throw new DOMException("Quota exceeded.", "QuotaExceededError");
				if ((store.record?.spki ?? null) !== expected) return false;
				store.record = candidate;
				return true;
			},
		},
	);
	const views: unknown[] = [];
	client.attempts.subscribe((view) => views.push(view));
	const queue = (path: string, ...answers: Script[]) =>
		scripts.set(path, [...(scripts.get(path) ?? []), ...answers]);
	const to = (path: string) => sent.filter((request) => request.path === path);
	const view = () => views.at(-1) as Record<string, unknown>;
	return { client, store, queue, sent, to, navigations, events, candidates, view };
}
/** Wait for the scripted studio to reach a state, as the awaits in between settle. */
async function until(reached: () => boolean, timeoutMs = 5000) {
	const deadline = performance.now() + timeoutMs;
	while (!reached() && performance.now() < deadline) await Bun.sleep(1);
	expect(reached()).toBe(true);
}
const restartedMessage = "Sign-in restarted. Enter your username and password again.";
const signIn = { username: "owner", password: "correct horse battery staple" };
const claimFields = { token: "claim-token", ...signIn };

test("sign-in signs with a new candidate, names the signing base, and binds after the commit", async () => {
	const base = await newKey();
	const h = await harness({ stored: base });
	h.queue("/owner/sign-in", session("s1"));
	expect(await h.client.attempts.submit("sign-in", signIn)).toBe("/");
	const [request] = h.to("/owner/sign-in");
	const candidate = h.candidates[0];
	expect(request.body.key).toBe(candidate.spki);
	expect((request.body.replaces as { key: string }).key).toBe(base.spki);
	expect(h.store.record).toBe(candidate);
	expect(h.client.bound()).toEqual({ sessionId: "s1", loginId: "login-s1" });
	expect(h.client.attempts.held).toBeNull();
});

test("claim and a sign-in without a signing base send no replaces", async () => {
	const h = await harness({ path: "/setup" });
	h.queue("/owner/claim", session("s1"));
	expect(await h.client.attempts.submit("claim", claimFields)).toBe("/settings/security?offer");
	expect("replaces" in h.to("/owner/claim")[0].body).toBe(false);
	// No stored record, or one that cannot sign: no base. The commit still expects its SPKI.
	for (const stored of [null, await newKey()]) {
		const k = await harness({ stored, signing: false });
		k.queue("/owner/sign-in", session("s2"));
		expect(await k.client.attempts.submit("sign-in", signIn)).toBe("/");
		expect("replaces" in k.to("/owner/sign-in")[0].body).toBe(false);
		expect(k.store.record).toBe(k.candidates[0]);
	}
});

test("the factor step and its retries reuse the sign-in's candidate and base", async () => {
	const base = await newKey();
	const h = await harness({ stored: base });
	h.queue("/owner/sign-in", proof());
	expect(await h.client.attempts.submit("sign-in", signIn)).toBeNull();
	expect(h.view()).toMatchObject({ factor: true });
	// Sign-in settled with a pending proof: its credentials are not held any longer.
	expect(h.client.attempts.held?.fields).toBeNull();
	expect(storage.get("siluet-sign-in-pending")).toBe("1");
	h.queue("/owner/factor", refused("invalid-code"), session("s1"));
	await h.client.attempts.factor("000000");
	expect(h.view()).toMatchObject({ factor: true, message: "Refused: invalid-code" });
	expect(h.client.attempts.held?.proof).toBe(true);
	expect(await h.client.attempts.factor("123456")).toBe("/");
	const keys = [...h.to("/owner/sign-in"), ...h.to("/owner/factor")].map((r) => r.body.key);
	expect(new Set(keys)).toEqual(new Set([h.candidates[0].spki]));
	for (const request of h.to("/owner/factor"))
		expect((request.body.replaces as { key: string }).key).toBe(base.spki);
	expect(h.candidates).toHaveLength(1);
	expect(storage.has("siluet-sign-in-pending")).toBe(false);
});

test("a lost claim, sign-in or factor answer commits through the candidate's resume without re-entry", async () => {
	for (const step of ["claim", "sign-in", "factor"] as const) {
		const h = await harness({ path: step === "claim" ? "/setup" : "/sign-in" });
		if (step === "factor") {
			h.queue("/owner/sign-in", proof());
			await h.client.attempts.submit("sign-in", signIn);
			h.queue("/owner/factor", "network");
		} else h.queue(`/owner/${step}`, "network");
		h.queue("/owner/resume", (body) => {
			expect(body.key).toBe(h.candidates[0].spki);
			return session("s1");
		});
		const destination =
			step === "factor"
				? await h.client.attempts.factor("123456")
				: await h.client.attempts.submit(step, step === "claim" ? claimFields : signIn);
		expect(destination).toBe(step === "claim" ? "/settings/security?offer" : "/");
		expect(h.store.record).toBe(h.candidates[0]);
		expect(h.to(`/owner/${step}`)).toHaveLength(1);
	}
});

test("a candidate resume 401 resends the held fields once on the same candidate and base", async () => {
	const base = await newKey();
	const h = await harness({ stored: base });
	h.queue("/owner/sign-in", "network", session("s1"));
	expect(await h.client.attempts.submit("sign-in", signIn)).toBe("/");
	const [first, resend] = h.to("/owner/sign-in");
	expect(resend.body).toMatchObject({ ...signIn, key: first.body.key });
	expect((resend.body.replaces as { key: string }).key).toBe(base.spki);
	expect(resend.body.nonce === first.body.nonce).toBe(false);
});

test("a refused resend resumes once more: a session commits, a 401 applies its own reason", async () => {
	// The original landed after all: its resend gets session-live, the resume finds the session.
	const h = await harness();
	h.queue("/owner/sign-in", "network", refused("session-live", 409));
	h.queue("/owner/resume", gone, session("s1"));
	expect(await h.client.attempts.submit("sign-in", signIn)).toBe("/");
	// A factor resend refused for its code keeps the proof.
	const f = await harness();
	f.queue("/owner/sign-in", proof());
	await f.client.attempts.submit("sign-in", signIn);
	f.queue("/owner/factor", "network", refused("invalid-code"));
	f.queue("/owner/resume", gone, gone);
	await f.client.attempts.factor("123456");
	expect(f.view()).toMatchObject({ factor: true, retry: false, message: "Refused: invalid-code" });
	expect(f.client.attempts.held?.proof).toBe(true);
	// A resend refused as stale restarts the sign-in.
	f.queue("/owner/factor", "network", refused("stale-proof"));
	f.queue("/owner/resume", gone, gone);
	await f.client.attempts.factor("654321");
	expect(f.view()).toMatchObject({
		factor: false,
		message: "Sign-in restarted. Enter your username and password again.",
	});
	expect(f.client.attempts.held).toBeNull();
});

test("a refused resend whose resume answers an access error shows it: host recovery, or Retry", async () => {
	for (const [retry, message] of [
		[false, "Stop Siluet and recover."],
		[true, "Storage is busy."],
	] as const) {
		const h = await harness();
		h.queue("/owner/sign-in", "network", refused("invalid-login"));
		h.queue("/owner/resume", gone, {
			status: 503,
			body: { message, retry, recoveryRequired: !retry },
		});
		await h.client.attempts.submit("sign-in", signIn);
		expect(h.view()).toMatchObject({ retry, message });
		if (retry) expect(h.client.attempts.held?.fields).toEqual(Object.keys(signIn));
		else expect(h.client.attempts.held).toBeNull();
	}
});

test("a second lost answer offers Retry, which resumes first and resends only on a 401", async () => {
	const h = await harness();
	h.queue("/owner/sign-in", "network", "network");
	await h.client.attempts.submit("sign-in", signIn);
	expect(h.view()).toMatchObject({ retry: true });
	expect(h.client.attempts.held?.fields).toEqual(Object.keys(signIn));
	h.queue("/owner/resume", session("s1"));
	expect(await h.client.attempts.retry()).toBe("/");
	expect(h.to("/owner/sign-in")).toHaveLength(2);
	expect(h.store.record).toBe(h.candidates[0]);
});

test("a resend answered 429, then a resume 401, still offers Retry; a failing resume then recovers", async () => {
	const h = await harness();
	h.queue("/owner/sign-in", "network", { status: 429, body: { message: "Too many." } });
	await h.client.attempts.submit("sign-in", signIn);
	expect(h.view()).toMatchObject({ retry: true, message: "Too many." });
	h.queue("/owner/sign-in", { status: 429, body: { message: "Too many." } });
	await h.client.attempts.retry();
	expect(h.view()).toMatchObject({ retry: true });
	// A failing lost-answer resume, then Retry recovering without re-entry.
	h.queue("/owner/resume", { status: 500 }, session("s1"));
	await h.client.attempts.retry();
	expect(h.view()).toMatchObject({ retry: true });
	expect(await h.client.attempts.retry()).toBe("/");
	expect(h.candidates).toHaveLength(1);
});

test("a non-retryable access error shows its host-recovery message without Retry", async () => {
	const h = await harness();
	h.queue("/owner/sign-in", {
		status: 503,
		body: { message: "Stop Siluet and recover.", retry: false, recoveryRequired: true },
	});
	await h.client.attempts.submit("sign-in", signIn);
	expect(h.view()).toMatchObject({ retry: false, message: "Stop Siluet and recover." });
	const r = await harness();
	r.queue("/owner/sign-in", {
		status: 503,
		body: { message: "Storage is busy.", retry: true, recoveryRequired: false },
	});
	await r.client.attempts.submit("sign-in", signIn);
	expect(r.view()).toMatchObject({ retry: true, message: "Storage is busy." });
	expect(r.client.attempts.held?.fields).toEqual(Object.keys(signIn));
});

test("refusals: stale-proof, a missing reason and others drop both and clear the proof", async () => {
	for (const answer of [refused("stale-proof"), refused(), refused("invalid-signature")]) {
		const h = await harness();
		h.queue("/owner/sign-in", proof());
		await h.client.attempts.submit("sign-in", signIn);
		h.queue("/owner/factor", answer);
		await h.client.attempts.factor("123456");
		expect(h.view()).toMatchObject({
			factor: false,
			message: "Sign-in restarted. Enter your username and password again.",
		});
		expect(h.client.attempts.held).toBeNull();
		expect(storage.has("siluet-sign-in-pending")).toBe(false);
	}
	const h = await harness({ path: "/setup" });
	h.queue("/owner/claim", refused("invalid-claim"));
	await h.client.attempts.submit("claim", claimFields);
	expect(h.view()).toMatchObject({ message: "Refused: invalid-claim" });
	expect(h.client.attempts.held).toBeNull();
});

test("a submit, factor step or Retry after another tab's commit drops both and loads /", async () => {
	const base = await newKey();
	const h = await harness({ stored: base });
	h.queue("/owner/sign-in", proof());
	await h.client.attempts.submit("sign-in", signIn);
	h.store.record = await newKey();
	await h.client.attempts.factor("123456");
	expect(h.navigations).toEqual(["assign /"]);
	expect(h.to("/owner/factor")).toHaveLength(0);
	// The pending marker stays, so `/sign-in` says the sign-in restarted unless `/` joins a session.
	expect(storage.get("siluet-sign-in-pending")).toBe("1");
	// After a lost answer the candidate resumes first and signs out the login it was given.
	for (const resumed of [session("s9", "login-9"), gone]) {
		const l = await harness({ stored: base });
		l.queue("/owner/sign-in", "network", "network");
		await l.client.attempts.submit("sign-in", signIn);
		l.store.record = await newKey();
		l.queue("/owner/resume", resumed);
		l.queue("/owner/sign-out", { status: 200, body: { signedOut: true } });
		await l.client.attempts.retry();
		expect(l.navigations).toEqual(["assign /"]);
		const signOuts = l.to("/owner/sign-out");
		if (resumed === gone) expect(signOuts).toHaveLength(0);
		else
			expect(signOuts.map((r) => [r.body.key, r.body.loginId])).toEqual([
				[l.candidates[0].spki, "login-9"],
			]);
	}
});

test("a primary submit after another tab stored a key loads / instead of signing in", async () => {
	const h = await harness({ stored: await newKey() });
	await h.client.prepare();
	h.store.record = await newKey();
	expect(await h.client.attempts.submit("sign-in", signIn)).toBeNull();
	expect(h.navigations).toEqual(["assign /"]);
	expect(h.to("/owner/sign-in")).toHaveLength(0);
	expect(h.client.attempts.held).toBeNull();
});

test("a commit notice during the tab's own request waits; the commit is then refused and signed out", async () => {
	const base = await newKey();
	const h = await harness({ stored: base });
	const answer = Promise.withResolvers<Answer>();
	h.queue("/owner/sign-in", answer.promise);
	h.queue("/owner/sign-out", { status: 200, body: { signedOut: true } });
	const submitted = h.client.attempts.submit("sign-in", signIn);
	await until(() => h.to("/owner/sign-in").length === 1);
	// Another tab commits; this tab's focus check finds its key while the request is in flight.
	h.store.record = await newKey();
	await h.client.check(true);
	expect(h.navigations).toEqual([]);
	answer.resolve(session("s1", "login-1"));
	expect(await submitted).toBeNull();
	expect(h.events).toEqual(["commit"]);
	expect(h.to("/owner/sign-out").map((r) => r.body.loginId)).toEqual(["login-1"]);
	expect(h.navigations).toEqual(["assign /"]);
	expect(h.client.mode === "bound").toBe(false);
	// A lost-answer resume in flight defers a check the same way.
	const l = await harness({ stored: base });
	const resumed = Promise.withResolvers<Answer>();
	l.queue("/owner/sign-in", "network");
	l.queue("/owner/resume", resumed.promise);
	const pending = l.client.attempts.submit("sign-in", signIn);
	await until(() => l.to("/owner/resume").length === 1);
	l.store.record = await newKey();
	await l.client.check(true);
	expect(l.to("/owner/resume")).toHaveLength(1);
	resumed.resolve(session("s2"));
	await pending;
	expect(l.navigations).toEqual(["assign /"]);
});

test("a stored-key change found behind a pending proof or a refusal applies once it settles", async () => {
	for (const outcome of ["proof", "refused"] as const) {
		const h = await harness({ stored: await newKey() });
		await h.client.prepare();
		const answer = Promise.withResolvers<Answer>();
		h.queue("/owner/sign-in", answer.promise);
		const submitted = h.client.attempts.submit("sign-in", signIn);
		await until(() => h.to("/owner/sign-in").length === 1);
		h.store.record = await newKey();
		await h.client.check(true);
		expect(h.navigations).toEqual([]);
		// A refusal drops the candidate: the tab then resumes the new key like any `/sign-in` tab.
		h.queue("/owner/resume", session("s1"));
		answer.resolve(outcome === "proof" ? proof() : refused("invalid-login"));
		await submitted;
		await until(() => h.navigations.length > 0);
		expect(h.navigations).toEqual(["assign /"]);
	}
});

test("a failing put shows the key message, signs the candidate out and clears a factor proof", async () => {
	const base = await newKey();
	const h = await harness({ stored: base });
	h.queue("/owner/sign-in", proof());
	await h.client.attempts.submit("sign-in", signIn);
	h.store.failCommit = true;
	h.queue("/owner/factor", session("s1", "login-1"));
	h.queue("/owner/sign-out", "network");
	expect(await h.client.attempts.factor("123456")).toBeNull();
	expect(h.view()).toMatchObject({
		factor: false,
		message: expect.stringContaining("cannot keep"),
	});
	expect(h.to("/owner/sign-out").map((r) => r.body.key)).toEqual([h.candidates[0].spki]);
	// A failed cleanup leaves the local record unchanged.
	expect(h.store.record).toBe(base);
	expect(h.client.attempts.held).toBeNull();
	expect(storage.has("siluet-sign-in-pending")).toBe(false);
});

test("cancel sends no replaces, retires nothing and drops both", async () => {
	const h = await harness({ stored: await newKey() });
	h.queue("/owner/sign-in", proof());
	await h.client.attempts.submit("sign-in", signIn);
	h.queue("/owner/factor", { status: 200, body: { cancelled: true } });
	await h.client.attempts.cancel();
	const [cancel] = h.to("/owner/factor");
	expect(cancel.body.cancel).toBe(true);
	expect("replaces" in cancel.body).toBe(false);
	expect(h.client.attempts.held).toBeNull();
	expect(h.view()).toMatchObject({ factor: false });
});

test("pagehide stops every later step; a cache return restarts only a pending factor step", async () => {
	// During key generation: nothing is sent.
	const g = await harness();
	const submitted = g.client.attempts.submit("sign-in", signIn);
	g.client.pagehide();
	await submitted;
	expect(g.sent).toEqual([]);
	g.client.pageshow(true);
	// The return's own check settles first: no "Sign-in restarted" follows it.
	await g.client.check(true);
	expect(g.view()).toMatchObject({ factor: false, message: null });
	// During the answer: nothing is stored or bound.
	for (const step of ["sign-in", "factor"] as const) {
		const h = await harness();
		if (step === "factor") {
			h.queue("/owner/sign-in", proof());
			await h.client.attempts.submit("sign-in", signIn);
		}
		const answer = Promise.withResolvers<Answer>();
		h.queue(`/owner/${step}`, answer.promise);
		const sent =
			step === "factor"
				? h.client.attempts.factor("123456")
				: h.client.attempts.submit(step, signIn);
		await until(() => h.to(`/owner/${step}`).length === 1);
		h.client.pagehide();
		answer.resolve(session("s1"));
		await sent;
		expect(h.events).toEqual([]);
		expect(h.client.attempts.held).toBeNull();
		h.client.pageshow(true);
		if (step === "factor") await until(() => h.view().message === restartedMessage);
		// The return's own check settles first: no "Sign-in restarted" follows it.
		else await h.client.check(true);
		expect(h.view()).toMatchObject({
			factor: false,
			message: step === "factor" ? restartedMessage : null,
		});
	}
});

test("pagehide during a refused or failed commit's sign-out shows and loads nothing", async () => {
	for (const outcome of ["refused", "write failure"] as const) {
		const h = await harness({ stored: await newKey() });
		const other = await newKey();
		h.store.failCommit = outcome === "write failure";
		h.queue("/owner/sign-in", () => {
			if (outcome === "refused") h.store.record = other;
			return session("s1", "login-1");
		});
		const signedOut = Promise.withResolvers<Answer>();
		h.queue("/owner/sign-out", signedOut.promise);
		const submitted = h.client.attempts.submit("sign-in", signIn);
		await until(() => h.to("/owner/sign-out").length === 1);
		h.client.pagehide();
		signedOut.resolve({ status: 200, body: { signedOut: true } });
		await submitted;
		expect(h.navigations).toEqual([]);
		expect(h.view()).toMatchObject({ message: null });
	}
});

test("pagehide while a factor step or Retry reads the stored key or resumes the candidate does nothing more", async () => {
	// During the stored-key read before the step.
	for (const step of ["factor", "retry"] as const) {
		const h = await harness({ stored: await newKey() });
		if (step === "factor") h.queue("/owner/sign-in", proof());
		else h.queue("/owner/sign-in", "network", "network");
		await h.client.attempts.submit("sign-in", signIn);
		const read = Promise.withResolvers<void>();
		h.store.readHold = read.promise;
		h.store.record = await newKey();
		const reads = h.store.reads;
		const pending =
			step === "factor" ? h.client.attempts.factor("123456") : h.client.attempts.retry();
		await until(() => h.store.reads > reads);
		h.client.pagehide();
		read.resolve();
		await pending;
		expect(h.navigations).toEqual([]);
		expect(h.to("/owner/resume")).toHaveLength(step === "retry" ? 1 : 0);
	}
	// During the lost candidate's resume or sign-out before joining the stored key.
	for (const held of ["/owner/resume", "/owner/sign-out"] as const) {
		const l = await harness({ stored: await newKey() });
		l.queue("/owner/sign-in", "network", "network");
		await l.client.attempts.submit("sign-in", signIn);
		l.store.record = await newKey();
		const answer = Promise.withResolvers<Answer>();
		l.queue("/owner/resume", held === "/owner/resume" ? answer.promise : session("s9", "login-9"));
		if (held === "/owner/sign-out") l.queue(held, answer.promise);
		const retried = l.client.attempts.retry();
		await until(() => l.to(held).length === (held === "/owner/resume" ? 2 : 1));
		l.client.pagehide();
		answer.resolve(held === "/owner/resume" ? session("s9", "login-9") : { status: 200 });
		await retried;
		expect(l.to("/owner/sign-out")).toHaveLength(held === "/owner/resume" ? 0 : 1);
		expect(l.navigations).toEqual([]);
	}
});

test("pagehide while joining another tab's key after a lost factor answer keeps the pending proof for the cache return", async () => {
	const h = await harness({ stored: await newKey() });
	h.queue("/owner/sign-in", proof());
	await h.client.attempts.submit("sign-in", signIn);
	h.queue("/owner/factor", "network", "network");
	await h.client.attempts.factor("123456");
	expect(h.view()).toMatchObject({ retry: true });
	h.store.record = await newKey();
	const answer = Promise.withResolvers<Answer>();
	h.queue("/owner/resume", answer.promise);
	const retried = h.client.attempts.retry();
	await until(() => h.to("/owner/resume").length === 2);
	h.client.pagehide();
	answer.resolve(gone);
	await retried;
	expect(h.navigations).toEqual([]);
	// The proof was pending: the cache return says "Sign-in restarted" unless a session is joined.
	expect(h.client.attempts.pageshow()).toBe(true);
});

test("a cache return after pagehide interrupted a commit re-reads the stored key", async () => {
	for (const outcome of ["joined", "no session"] as const) {
		const h = await harness();
		h.queue("/owner/sign-in", proof());
		await h.client.attempts.submit("sign-in", signIn);
		const write = Promise.withResolvers<void>();
		h.store.hold = write.promise;
		h.queue("/owner/factor", session("s1"));
		const factor = h.client.attempts.factor("123456");
		await until(() => h.events.length === 1);
		expect(h.events).toEqual(["commit"]);
		h.client.pagehide();
		write.resolve();
		await factor;
		// The write landed, but the hidden page bound nothing.
		expect(h.store.record).toBe(h.candidates[0]);
		expect(h.client.mode === "bound").toBe(false);
		h.queue("/owner/resume", outcome === "joined" ? session("s1") : gone);
		h.client.pageshow(true);
		if (outcome === "joined") {
			await until(() => h.navigations.length === 1);
			expect(h.navigations).toEqual(["assign /"]);
			expect(h.view()).toMatchObject({ message: null });
		} else {
			// The restart shows only once the return's resume settled.
			await until(() => h.view().message === restartedMessage);
			expect(h.navigations).toEqual([]);
		}
	}
});

test("/sign-in and /setup load / for a new stored key's session, else stay", async () => {
	for (const path of ["/sign-in", "/setup"]) {
		const h = await harness({ path });
		await h.client.prepare();
		h.store.record = await newKey();
		h.queue("/owner/resume", gone);
		await h.client.check(true);
		expect(h.navigations).toEqual([]);
		// The same key again sends nothing; another one with a session loads `/`.
		await h.client.check(true);
		expect(h.to("/owner/resume")).toHaveLength(1);
		h.store.record = await newKey();
		h.queue("/owner/resume", session("s1"));
		await h.client.check(true);
		expect(h.navigations).toEqual(["assign /"]);
	}
});

test("a new stored key whose resume fails stays pending: the next check resumes it", async () => {
	const failures: Answer[] = [
		"network",
		{ status: 500 },
		{ status: 429 },
		{ status: 503, body: { message: "Storage is busy.", retry: true, recoveryRequired: false } },
	];
	for (const failure of failures) {
		const h = await harness();
		await h.client.prepare();
		h.store.record = await newKey();
		h.queue("/owner/resume", failure);
		await h.client.check(true);
		expect(h.navigations).toEqual([]);
		h.queue("/owner/resume", session("s1"));
		await h.client.check(true);
		expect(h.to("/owner/resume")).toHaveLength(2);
		expect(h.navigations).toEqual(["assign /"]);
	}
});

test("a load that joins a session clears the pending sign-in marker", async () => {
	const h = await harness({ stored: await newKey(), path: "/" });
	storage.set("siluet-sign-in-pending", "1");
	h.queue("/owner/resume", session("s1"));
	await h.client.classify(await h.client.renew());
	expect(storage.has("siluet-sign-in-pending")).toBe(false);
});

test("the codes hold checks a new key while a destination waits: changed, and Done opens Security", async () => {
	for (const [rotation, notice] of [
		["changed", "changed"],
		["replaced", "replaced"],
	] as const) {
		const old = await newKey();
		const h = await harness({ stored: old, path: "/jobs" });
		h.queue("/owner/resume", session("s1"));
		await h.client.classify(await h.client.renew());
		h.client.beginSecurity();
		h.client.stashSecurityBearer("successor");
		h.client.settleSecurity({ sessionId: "s2", codes: ["a"] }, true, page.href);
		h.client.refused("successor");
		if (rotation === "replaced") {
			// A later Security change from this login marks the codes "do not keep these".
			h.queue("/owner/resume", session("s3", "login-s1"));
			await h.client.check();
		} else {
			// The old key's session ends before the new key is stored: signed out to `/sign-in`.
			h.queue("/owner/resume", gone);
			await h.client.check();
		}
		expect(h.client.mode).toBe("held");
		// The new key's resume joins its live session; "replaced" sticks.
		h.store.record = await newKey();
		h.queue("/owner/resume", session("s4", "login-new"));
		await h.client.check(true);
		expect(h.to("/owner/resume")).toHaveLength(3);
		expect(h.to("/owner/resume").at(-1)?.body.key).toBe(h.store.record.spki);
		const views = [] as unknown[];
		h.client.subscribe((state) => views.push(state));
		expect(views.at(-1)).toMatchObject({ codes: { notice } });
		h.client.done();
		expect(h.navigations).toEqual([`replace ${origin}/settings/security`]);
	}
});

test("sign-out applies against its start; a key stored since resumes and joins with an offer", async () => {
	const old = await newKey();
	const bindTo = async (h: Awaited<ReturnType<typeof harness>>) => {
		h.queue("/owner/resume", session("s1", "login-1"));
		await h.client.classify(await h.client.renew());
	};
	// A held 200 lands after another tab rotated: the tab joins the fresh session at `/`.
	const h = await harness({ stored: old, path: "/" });
	await bindTo(h);
	const answer = Promise.withResolvers<Answer>();
	h.queue("/owner/sign-out", answer.promise);
	const out = h.client.signOut();
	await until(() => h.to("/owner/sign-out").length === 1);
	h.store.record = await newKey();
	h.queue("/owner/resume", session("s2", "login-2"));
	answer.resolve({ status: 200, body: { signedOut: true } });
	expect(await out).toBe("other");
	expect(h.to("/owner/sign-out")[0].body).toMatchObject({ key: old.spki, loginId: "login-1" });
	expect(storage.get("siluet-sign-out-offer")).toBe("s2");
	expect(h.navigations).toEqual(["reload"]);
	// The next document consumes the offer only on `/` bound to that session.
	const reloaded = await harness({ stored: h.store.record, path: "/", reload: true });
	expect(storage.has("siluet-sign-out-offer")).toBe(false);
	reloaded.queue("/owner/resume", session("s2", "login-2"));
	await reloaded.client.classify(await reloaded.client.renew());
	expect(reloaded.client.takeSignOutOffer()).toBe(true);
	expect(reloaded.client.takeSignOutOffer()).toBe(false);
	// Bound to another session, the offer is dropped.
	storage.set("siluet-sign-out-offer", "s2");
	const other = await harness({ stored: h.store.record, path: "/", reload: true });
	other.queue("/owner/resume", session("s3"));
	await other.client.classify(await other.client.renew());
	expect(other.client.takeSignOutOffer()).toBe(false);
	// The re-read key's "Session gone" opens `/sign-in`.
	const g = await harness({ stored: old, path: "/" });
	await bindTo(g);
	g.queue("/owner/sign-out", { status: 200, body: { signedOut: true } });
	g.store.record = await newKey();
	g.queue("/owner/resume", gone);
	expect(await g.client.signOut()).toBe("signed-out");
	expect(g.navigations).toEqual(["assign /sign-in"]);
});

test("a 409 sign-out checks and carries the offer across the document load it starts", async () => {
	const h = await harness({ stored: await newKey(), path: "/" });
	h.queue("/owner/resume", session("s1", "login-1"));
	await h.client.classify(await h.client.renew());
	h.client.refused("bearer-s1");
	h.queue("/owner/sign-out", { status: 409, body: { message: "Signed in again since." } });
	h.queue("/owner/resume", session("s2", "login-2"));
	expect(await h.client.signOut()).toBe("other");
	await until(() => h.navigations.length === 1);
	expect(h.navigations).toEqual(["reload"]);
	expect(storage.get("siluet-sign-out-offer")).toBe("s2");
	// A back/forward-cache restore clears it.
	h.client.pagehide();
	h.client.pageshow(true);
	expect(storage.has("siluet-sign-out-offer")).toBe(false);
	expect(h.client.takeSignOutOffer()).toBe(false);
});

test("a bound tab whose key was rotated while it resumed tries the stored key once more", async () => {
	const h = await harness({ stored: await newKey(), path: "/jobs" });
	h.queue("/owner/resume", session("s1", "login-1"));
	await h.client.classify(await h.client.renew());
	h.client.refused("bearer-s1");
	const answer = Promise.withResolvers<Answer>();
	h.queue("/owner/resume", answer.promise, session("s2", "login-2"));
	const check = h.client.check();
	await until(() => h.to("/owner/resume").length === 2);
	h.store.record = await newKey();
	answer.resolve(gone);
	await check;
	// "Replaced key" became "Other ID", without signing the tab out.
	expect(
		h
			.to("/owner/resume")
			.map((r) => r.body.key)
			.slice(1),
	).toEqual([h.to("/owner/resume")[1].body.key, h.store.record.spki]);
	expect(h.navigations).toEqual(["reload"]);
});

test("a write that fails after pagehide does nothing more; the return restarts the factor step", async () => {
	const h = await harness();
	h.queue("/owner/sign-in", proof());
	await h.client.attempts.submit("sign-in", signIn);
	const write = Promise.withResolvers<void>();
	h.store.hold = write.promise;
	h.store.failCommit = true;
	h.queue("/owner/factor", session("s1"));
	const factor = h.client.attempts.factor("123456");
	await until(() => h.events.length === 1);
	h.client.pagehide();
	write.resolve();
	await factor;
	expect(h.to("/owner/sign-out")).toHaveLength(0);
	expect(h.view()).toMatchObject({ message: null });
	h.client.pageshow(true);
	await until(() => h.view().message === restartedMessage);
});
