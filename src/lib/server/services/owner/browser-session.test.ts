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
	const install: Installation = await openInstallation(directory);
	cleanup.push(() => install.close());
	const bearers = createBearers();
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
	async function call(
		purpose: KeyPurpose,
		key: Key,
		fields: Record<string, unknown> = {},
		binding = "",
		sent = key.spki,
	) {
		const { nonce } = await (await sessions.challenge(post({ purpose }))).json();
		const message = { purpose, origin: origin.origin, installation: install.id, binding, nonce };
		const signature = toBase64Url(
			new Uint8Array(
				await crypto.subtle.sign(
					{ name: "ECDSA", hash: "SHA-256" },
					key.privateKey,
					keyMessage(message),
				),
			),
		);
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
	return {
		install,
		access,
		sessions,
		call,
		post,
		password,
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

test("raced claims and sign-ins: one claim wins; each key keeps its own session", async () => {
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
	const [first, second] = await Promise.all(signIns.map((r) => r.json()));
	expect(first.loginId === second.loginId).toBe(false);
	expect(await s.install.use((db) => db.get(sql`SELECT count(*) AS n FROM session`))).toEqual({
		n: 2,
	});
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
	const again = await (
		await s.call("sign-in", b, { username: "owner", password: s.password })
	).json();
	const cancelled = await s.call(
		"factor",
		b,
		{ proof: again.proof, cancel: true },
		sessionDigest(again.proof),
	);
	expect(await cancelled.json()).toEqual({ cancelled: true });
}, 30000);
