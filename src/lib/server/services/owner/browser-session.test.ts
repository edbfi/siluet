import { afterEach, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { sql } from "drizzle-orm";
import { TOTP } from "otpauth";
import { createOwnerDirectory } from "../../../../../tests/fixtures/owner-directory";
import { type KeyPurpose, keyMessage, toBase64Url } from "../../../shared/owner/key-message";
import { type Installation, openInstallation } from "../../db/installation";
import { createOwnerAccess } from "./access";
import { AccessError, recoverMessage } from "./access-error";
import { createBearers } from "./bearers";
import { createBrowserSessions } from "./browser-session";
import { createChallenges } from "./challenges";
import { sessionDigest } from "./credentials";

const origin = new URL("http://127.0.0.1:4321");
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
	for (const step of cleanup.splice(0).reverse()) await step();
});

async function browserKey() {
	const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, [
		"sign",
		"verify",
	]);
	const spki = toBase64Url(new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey)));
	return { spki, privateKey: pair.privateKey };
}
type Key = Awaited<ReturnType<typeof browserKey>>;

async function studio() {
	const directory = await createOwnerDirectory();
	cleanup.push(() => rm(directory, { recursive: true, force: true }));
	const opened: Installation = await openInstallation(directory);
	cleanup.push(() => opened.close());
	const bearers = createBearers();
	// Retired sessions drop their bearers and staged work, as the runtime wires them.
	const retired: string[] = [];
	const install: Installation = {
		...opened,
		retireSessions(digests) {
			retired.push(...digests);
			bearers.retireSessions(digests);
		},
	};
	const access = createOwnerAccess(install, Date.now, origin.origin, bearers);
	let accessFailure: AccessError | null = null;
	let accessChecks = 0;
	const sessions = createBrowserSessions({
		access,
		challenges: createChallenges(),
		origin,
		installation: install.id,
		hasOwner: install.hasOwner,
		async checkAccess() {
			accessChecks++;
			if (accessFailure) throw accessFailure;
		},
	});
	const post = (body: unknown) =>
		new Request(origin, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
	const signAs = async (key: Key, purpose: KeyPurpose, binding: string, nonce: string) =>
		toBase64Url(
			new Uint8Array(
				await crypto.subtle.sign(
					{ name: "ECDSA", hash: "SHA-256" },
					key.privateKey,
					keyMessage({ purpose, origin: origin.origin, installation: install.id, binding, nonce }),
				),
			),
		);
	/** `replaces` signed by `base` for the candidate `key`, or another value it is given. */
	async function call(
		purpose: KeyPurpose,
		key: Key,
		fields: Record<string, unknown> = {},
		binding = "",
		sent = key.spki,
		replaces?: (nonce: string) => Promise<unknown>,
	) {
		const { nonce } = await (await sessions.challenge(post({ purpose }))).json();
		const signature = await signAs(key, purpose, binding, nonce);
		if (replaces) fields = { ...fields, replaces: await replaces(nonce) };
		const route = {
			claim: sessions.claim,
			"sign-in": sessions.signIn,
			factor: sessions.factor,
			resume: sessions.resume,
			"sign-out": sessions.signOut,
		}[purpose];
		return route(post({ ...fields, key: sent, nonce, signature }));
	}
	const password = crypto.randomUUID();
	/** A `replaces` field signed by `base` for the candidate `key`. */
	const replacing =
		(base: Key, candidate: Key, purpose: KeyPurpose = "sign-in") =>
		async (nonce: string) => ({
			key: base.spki,
			signature: await signAs(base, purpose, `replaces:${candidate.spki}`, nonce),
		});
	return {
		install,
		access,
		sessions,
		call,
		signAs,
		replacing,
		post,
		password,
		retired,
		accessChecks: () => accessChecks,
		failAccess: (error: AccessError | null) => {
			accessFailure = error;
		},
		claim: (key: Key) =>
			call("claim", key, { token: access.rotate(), username: "owner", password }),
	};
}

test("a bad signature is refused with 403 before the access check or any storage", async () => {
	const s = await studio();
	const key = await browserKey();
	const other = await browserKey();
	const { nonce } = await (await s.sessions.challenge(s.post({ purpose: "claim" }))).json();
	const forged = await s.sessions.claim(
		s.post({
			key: key.spki,
			nonce,
			signature: toBase64Url(new Uint8Array(64)),
			token: s.access.rotate(),
			username: "owner",
			password: s.password,
		}),
	);
	expect(forged.status).toBe(403);
	expect(s.accessChecks()).toBe(0);
	expect(await s.install.hasOwner()).toBe(false);
	// The nonce was spent by the failed attempt.
	const replay = await s.sessions.claim(s.post({ key: key.spki, nonce, signature: "x" }));
	expect(replay.status).toBe(403);
	// A signature by another key, or with another binding, fails the same way.
	const token = s.access.rotate();
	const signedByOther = await s.call("claim", other, { token, password: s.password }, "", key.spki);
	expect(signedByOther.status).toBe(403);
	const wrongBinding = await s.call("resume", key, {}, "not the key");
	expect(wrongBinding.status).toBe(403);
	expect(await s.install.hasOwner()).toBe(false);
	// Signed rows run the access check after verifying.
	s.failAccess(new AccessError(recoverMessage, 503));
	const locked = await s.claim(key);
	expect(locked.status).toBe(503);
	expect(await locked.json()).toEqual({
		message: recoverMessage,
		retry: false,
		recoveryRequired: true,
	});
	expect(await s.install.hasOwner()).toBe(false);
});

test("a nonce answers once and only for its purpose; issue rates answer 429", async () => {
	const s = await studio();
	const challenge = (purpose: string) => s.sessions.challenge(s.post({ purpose }));
	expect((await challenge("unknown")).status).toBe(400);
	for (let i = 0; i < 30; i++) expect((await challenge("sign-out")).status).toBe(200);
	const limited = await challenge("sign-out");
	expect(limited.status).toBe(429);
	expect(limited.headers.get("cache-control")).toBe("no-store");
	const notJson = await s.sessions.challenge(new Request(origin, { method: "POST", body: "{}" }));
	expect(notJson.status).toBe(415);
});

test("claim, resume, sign-out and the session-gone answer, before and after claim", async () => {
	const s = await studio();
	const key = await browserKey();
	const gone = await s.call("resume", key, {}, key.spki);
	expect(gone.status).toBe(401);
	expect(await gone.json()).toEqual({
		message: "Your session ended. Sign in again.",
		location: "/setup",
	});
	const claimed = await s.claim(key);
	expect(claimed.status).toBe(200);
	const issued = await claimed.json();
	expect(Object.keys(issued).sort()).toEqual(["bearer", "loginId", "sessionId"]);
	expect((await s.access.session(issued.bearer))?.sessionId).toBe(issued.sessionId);
	// Resume issues a new bearer for the same session and retires the previous one.
	const resumed = await (await s.call("resume", key, { previous: issued.bearer }, key.spki)).json();
	expect(resumed.sessionId).toBe(issued.sessionId);
	expect(await s.access.session(issued.bearer)).toBeNull();
	expect((await s.access.session(resumed.bearer))?.loginId).toBe(issued.loginId);
	// Sign-out for another login is refused; for this login it ends the session.
	const other = await s.call("sign-out", key, { loginId: "another" }, "another");
	expect(other.status).toBe(409);
	const out = await s.call("sign-out", key, { loginId: issued.loginId }, issued.loginId);
	expect(out.status).toBe(200);
	expect(await s.access.session(resumed.bearer)).toBeNull();
	// Signing out an ended login again succeeds.
	expect((await s.call("sign-out", key, { loginId: issued.loginId }, issued.loginId)).status).toBe(
		200,
	);
	const after = await s.call("resume", key, {}, key.spki);
	expect(await after.json()).toEqual({
		message: "Your session ended. Sign in again.",
		location: "/sign-in",
	});
}, 30000);

test("resume and the session read leave last activity unchanged", async () => {
	const s = await studio();
	const key = await browserKey();
	const issued = await (await s.claim(key)).json();
	const activity = () =>
		s.install.use((db) =>
			db.get<{ last_activity: number }>(sql`SELECT last_activity FROM session`),
		);
	const before = await activity();
	await Bun.sleep(5);
	await s.call("resume", key, {}, key.spki);
	expect((await s.access.peek(issued.bearer))?.sessionId).toBe(issued.sessionId);
	expect(await activity()).toEqual(before);
	await s.access.session(issued.bearer);
	expect((await activity())?.last_activity).toBeGreaterThan(before?.last_activity ?? 0);
}, 30000);

test("raced claims: one claim wins; a key with a live session cannot sign in again", async () => {
	const s = await studio();
	const [a, b] = [await browserKey(), await browserKey()];
	const token = s.access.rotate();
	const results = await Promise.all(
		[a, b].map((key) => s.call("claim", key, { token, username: "owner", password: s.password })),
	);
	expect(results.map((r) => r.status).sort()).toEqual([200, 403]);
	const signIns = await Promise.all(
		[a, b].map((key) => s.call("sign-in", key, { username: "owner", password: s.password })),
	);
	// The claim's winner already has a session; the loser gets its own.
	expect(signIns.map((r) => r.status).sort()).toEqual([200, 409]);
	expect(await s.install.use((db) => db.get(sql`SELECT count(*) AS n FROM session`))).toEqual({
		n: 2,
	});
}, 30000);

/** Turn on two-step sign-in from `key`'s session; returns its recovery codes. */
async function enableFactor(s: Awaited<ReturnType<typeof studio>>, key: Key) {
	const resumed = await (await s.call("resume", key, {}, key.spki)).json();
	const session = await s.access.session(resumed.bearer);
	if (!session) throw new Error("Missing session.");
	const grant = await s.access.security.authorize("enable", session.digest, s.password, "");
	if (grant.kind !== "candidate") throw new Error("Missing candidate.");
	const totp = new TOTP({ secret: grant.manual });
	return (await s.access.security.activate("enable", session.digest, grant.digest, totp.generate()))
		.codes;
}
const sessionCount = (s: Awaited<ReturnType<typeof studio>>) =>
	s.install.use(
		async (db) => (await db.get<{ n: number }>(sql`SELECT count(*) AS n FROM session`))?.n,
	);

test("claim, sign-in and factor refusals name their reason; other refusals carry none", async () => {
	const s = await studio();
	const [a, b] = [await browserKey(), await browserKey()];
	const refusal = async (response: Response) => ({
		status: response.status,
		reason: (await response.json()).reason,
	});
	const token = s.access.rotate();
	const fields = { token, username: "owner", password: s.password };
	expect(await refusal(await s.call("claim", a, fields, "", b.spki))).toEqual({
		status: 403,
		reason: "invalid-signature",
	});
	expect(await refusal(await s.call("claim", a, { ...fields, token: "wrong" }))).toEqual({
		status: 403,
		reason: "invalid-claim",
	});
	expect(await refusal(await s.call("claim", a, { ...fields, username: " " }))).toEqual({
		status: 400,
		reason: undefined,
	});
	// Claim refuses any `replaces`, after spending the nonce.
	expect(
		await refusal(await s.call("claim", a, fields, "", a.spki, s.replacing(b, a, "claim"))),
	).toEqual({ status: 403, reason: "invalid-signature" });
	expect((await s.call("claim", a, fields)).status).toBe(200);
	expect(
		await refusal(await s.call("sign-in", b, { username: "owner", password: "wrong" })),
	).toEqual({ status: 403, reason: "invalid-login" });
	expect(
		await refusal(await s.call("sign-in", a, { username: "owner", password: s.password })),
	).toEqual({ status: 409, reason: "session-live" });
	const codes = await enableFactor(s, a);
	const pending = await (
		await s.call("sign-in", b, { username: "owner", password: s.password })
	).json();
	const binding = sessionDigest(pending.proof);
	expect(
		await refusal(await s.call("factor", b, { proof: pending.proof, code: "000000" }, binding)),
	).toEqual({ status: 403, reason: "invalid-code" });
	const unknown = crypto.randomUUID();
	expect(
		await refusal(
			await s.call("factor", b, { proof: unknown, code: codes[0] }, sessionDigest(unknown)),
		),
	).toEqual({ status: 403, reason: "stale-proof" });
}, 30000);

test("replaces is optional, and a malformed or misbound one is refused before password work", async () => {
	const s = await studio();
	const [a, other, candidate] = [await browserKey(), await browserKey(), await browserKey()];
	expect((await s.claim(a)).status).toBe(200);
	const fields = { username: "owner", password: s.password };
	const checks = s.accessChecks();
	const refused = [
		async () => "replaces",
		async () => null,
		async () => [],
		async () => ({ key: a.spki }),
		async () => ({ key: a.spki, signature: toBase64Url(new Uint8Array(64)) }),
		async (nonce: string) => ({
			key: candidate.spki,
			signature: await s.signAs(candidate, "sign-in", `replaces:${candidate.spki}`, nonce),
		}),
		async (nonce: string) => ({
			key: a.spki,
			signature: await s.signAs(a, "sign-in", `replaces:${other.spki}`, nonce),
		}),
		async () => ({
			key: a.spki,
			signature: await s.signAs(a, "sign-in", `replaces:${candidate.spki}`, "another nonce"),
		}),
		async (nonce: string) => ({
			key: a.spki,
			signature: await s.signAs(a, "factor", `replaces:${candidate.spki}`, nonce),
		}),
	];
	for (const replaces of refused) {
		const response = await s.call("sign-in", candidate, fields, "", candidate.spki, replaces);
		expect(response.status).toBe(403);
		expect((await response.json()).reason).toBe("invalid-signature");
	}
	expect(s.accessChecks()).toBe(checks);
	// The nonce is spent by a refused `replaces`.
	const { nonce } = await (await s.sessions.challenge(s.post({ purpose: "sign-in" }))).json();
	const signature = await s.signAs(candidate, "sign-in", "", nonce);
	const body = { ...fields, key: candidate.spki, nonce, signature };
	expect((await s.sessions.signIn(s.post({ ...body, replaces: "x" }))).status).toBe(403);
	const replay = { ...body, replaces: await s.replacing(a, candidate)(nonce) };
	expect((await s.sessions.signIn(s.post(replay))).status).toBe(403);
	expect(await sessionCount(s)).toBe(1);
	// Without a base, a sign-in sends none and is accepted.
	expect((await s.call("sign-in", other, fields)).status).toBe(200);
}, 30000);

test("issuing a session retires the base's session, bearers and pending proofs; a pending proof retires nothing", async () => {
	const s = await studio();
	const [a, c, d, e, f] = await Promise.all(Array.from({ length: 5 }, browserKey));
	const fields = { username: "owner", password: s.password };
	const claimed = await (await s.claim(a)).json();
	const base = await s.access.peek(claimed.bearer);
	const rotated = await s.call("sign-in", c, fields, "", c.spki, s.replacing(a, c));
	expect(rotated.status).toBe(200);
	expect(await s.access.peek(claimed.bearer)).toBeNull();
	expect(s.retired).toContain(base?.digest ?? "");
	expect((await s.call("resume", a, {}, a.spki)).status).toBe(401);
	expect((await s.call("resume", c, {}, c.spki)).status).toBe(200);
	const codes = await enableFactor(s, c);
	const live = await (await s.call("resume", c, {}, c.spki)).json();
	const liveDigest = (await s.access.peek(live.bearer))?.digest ?? "";
	// A pending proof for the candidate retires nothing.
	const pending = await (await s.call("sign-in", d, fields, "", d.spki, s.replacing(c, d))).json();
	expect(Object.keys(pending)).toEqual(["proof"]);
	expect(await s.access.peek(live.bearer)).not.toBeNull();
	expect(s.retired).not.toContain(liveDigest);
	// Factor completion with `replaces` retires the base's session and bearers.
	const done = await s.call(
		"factor",
		d,
		{ proof: pending.proof, code: codes[0] },
		sessionDigest(pending.proof),
		d.spki,
		s.replacing(c, d, "factor"),
	);
	expect(done.status).toBe(200);
	expect(await s.access.peek(live.bearer)).toBeNull();
	expect(s.retired).toContain(liveDigest);
	expect((await s.call("resume", c, {}, c.spki)).status).toBe(401);
	// A base with only a pending sign-in loses that proof when the candidate's session is issued.
	const proofE = (await (await s.call("sign-in", e, fields)).json()).proof;
	const proofF = (await (await s.call("sign-in", f, fields, "", f.spki, s.replacing(e, f))).json())
		.proof;
	const finished = await s.call(
		"factor",
		f,
		{ proof: proofF, code: codes[1] },
		sessionDigest(proofF),
		f.spki,
		s.replacing(e, f, "factor"),
	);
	expect(finished.status).toBe(200);
	const late = await s.call("factor", e, { proof: proofE, code: codes[2] }, sessionDigest(proofE));
	expect((await late.json()).reason).toBe("stale-proof");
	// Cancel retires nothing.
	expect(await sessionCount(s)).toBe(2);
}, 30000);

test("first commit wins: a live key cannot sign in again; the last pending proof wins", async () => {
	const s = await studio();
	const [a, b, c] = await Promise.all(Array.from({ length: 3 }, browserKey));
	const fields = { username: "owner", password: s.password };
	expect((await s.claim(a)).status).toBe(200);
	const raced = await Promise.all([s.call("sign-in", b, fields), s.call("sign-in", b, fields)]);
	expect(raced.map((r) => r.status).sort()).toEqual([200, 409]);
	expect(await sessionCount(s)).toBe(2);
	const codes = await enableFactor(s, a);
	// With two-step sign-in a live key gets no proof either.
	const again = await s.call("sign-in", a, fields);
	expect(again.status).toBe(409);
	expect((await again.json()).reason).toBe("session-live");
	const first = (await (await s.call("sign-in", c, fields)).json()).proof;
	const second = (await (await s.call("sign-in", c, fields)).json()).proof;
	const stale = await s.call("factor", c, { proof: first, code: codes[0] }, sessionDigest(first));
	expect((await stale.json()).reason).toBe("stale-proof");
	const won = await s.call("factor", c, { proof: second, code: codes[0] }, sessionDigest(second));
	expect(won.status).toBe(200);
	expect((await s.call("sign-in", c, fields)).status).toBe(409);
	// Cancel sends no `replaces` and retires nothing.
	const before = await sessionCount(s);
	await s.call("factor", c, { proof: second, cancel: true }, sessionDigest(second));
	expect(await sessionCount(s)).toBe(before);
}, 30000);

test("factor binds the pending proof's digest and acts only on the key's own proof", async () => {
	const s = await studio();
	const [a, b] = [await browserKey(), await browserKey()];
	const claimed = await (await s.claim(a)).json();
	const session = await s.access.session(claimed.bearer);
	if (!session) throw new Error("Missing session.");
	const grant = await s.access.security.authorize("enable", session.digest, s.password, "");
	if (grant.kind !== "candidate") throw new Error();
	const totp = new TOTP({ secret: grant.manual });
	const enabled = await s.access.security.activate(
		"enable",
		session.digest,
		grant.digest,
		totp.generate(),
	);
	const pending = await (
		await s.call("sign-in", b, { username: "owner", password: s.password })
	).json();
	expect(Object.keys(pending)).toEqual(["proof"]);
	const binding = sessionDigest(pending.proof);
	// The factor signature binds the proof's digest.
	expect((await s.call("factor", b, { proof: pending.proof, code: "0" }, "")).status).toBe(403);
	// Another key cannot finish it.
	const stolen = await s.call(
		"factor",
		a,
		{ proof: pending.proof, code: enabled.codes[0] },
		binding,
	);
	expect(stolen.status).toBe(403);
	const done = await s.call("factor", b, { proof: pending.proof, code: enabled.codes[0] }, binding);
	expect(done.status).toBe(200);
	const finished = await done.json();
	expect(finished.loginId === claimed.loginId).toBe(false);
	// A key with its own live session cannot start another; a third key cancels its proof.
	const c = await browserKey();
	const again = await (
		await s.call("sign-in", c, { username: "owner", password: s.password })
	).json();
	const cancelled = await s.call(
		"factor",
		c,
		{ proof: again.proof, cancel: true },
		sessionDigest(again.proof),
	);
	expect(await cancelled.json()).toEqual({ cancelled: true });
}, 30000);

test("two tabs rotating from one base: the loser's sign-out leaves the winner's session", async () => {
	const s = await studio();
	const [base, winner, loser] = await Promise.all(Array.from({ length: 3 }, browserKey));
	const fields = { username: "owner", password: s.password };
	expect((await s.claim(base)).status).toBe(200);
	const [won, lost] = await Promise.all(
		[winner, loser].map(async (key) =>
			(await s.call("sign-in", key, fields, "", key.spki, s.replacing(base, key))).json(),
		),
	);
	expect((await s.call("resume", base, {}, base.spki)).status).toBe(401);
	// The loser's tab cannot store its key, so it signs its own login out.
	const out = await s.call("sign-out", loser, { loginId: lost.loginId }, lost.loginId);
	expect(out.status).toBe(200);
	const kept = await (await s.call("resume", winner, {}, winner.spki)).json();
	expect(kept.loginId).toBe(won.loginId);
	expect(await sessionCount(s)).toBe(1);
}, 30000);
