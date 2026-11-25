import { expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { sql } from "drizzle-orm";
import { TOTP } from "otpauth";
import { createOwnerDirectory } from "../../../../../tests/fixtures/owner-directory";
import { accessStore } from "../../db/access-store";
import { type Installation, openInstallation } from "../../db/installation";
import { createOwnerAccess } from "./access";
import { createBearers } from "./bearers";
import { sessionDigest } from "./credentials";

const keyA = "browser-key-a";
const keyB = "browser-key-b";
const username = async (access: ReturnType<typeof createOwnerAccess>, bearer: string) =>
	(await access.session(bearer))?.username ?? null;
const proofLive = async (install: Installation, value: string) =>
	Boolean(
		await install.use((db) =>
			db.get(sql`SELECT 1 FROM owner_proof WHERE digest=${sessionDigest(value)}`),
		),
	);
const attempts = (install: Installation) =>
	install.use((db) => db.get<{ n: number }>(sql`SELECT count(*) AS n FROM factor_attempt`));
async function pendingSignIn(
	access: ReturnType<typeof createOwnerAccess>,
	password: string,
	key: string,
) {
	const result = await access.signIn("owner", password, key);
	if (result.kind !== "pending") throw new Error("Expected a pending sign-in.");
	return result.token;
}

test("enrollment rotates access, pending sign-in survives a failed session insert, and recovery codes succeed once", async () => {
	const dir = await createOwnerDirectory(),
		installation = await openInstallation(dir);
	try {
		const access = createOwnerAccess(installation);
		const password = crypto.randomUUID();
		const claimed = await access.claim(access.rotate(), "owner", password, keyA);
		const grant = await access.security.authorize("enable", claimed.digest, password, "");
		if (grant.kind !== "candidate") throw new Error();
		const step = new TOTP({ secret: grant.manual }).generate();
		const issued = await access.security.activate("enable", claimed.digest, grant.digest, step);
		expect(issued.codes).toHaveLength(10);
		expect(await access.session(claimed.bearer)).toBeNull();
		expect(await username(access, issued.bearer)).toBe("owner");
		const pending = await pendingSignIn(access, password, keyB);
		await expect(access.security.complete(pending, keyB, step)).rejects.toThrow("unused code");
		await installation.use((db) =>
			db.run(
				sql`CREATE TRIGGER abort_session BEFORE INSERT ON session BEGIN SELECT RAISE(ABORT,'fixture rollback'); END`,
			),
		);
		await expect(access.security.complete(pending, keyB, issued.codes[0])).rejects.toThrow();
		await installation.use((db) => db.run(sql`DROP TRIGGER abort_session`));
		const signed = await access.security.complete(pending, keyB, issued.codes[0]);
		expect(await username(access, signed.bearer)).toBe("owner");
		await expect(access.security.complete(pending, keyB, issued.codes[1])).rejects.toThrow();
		const next = await pendingSignIn(access, password, keyB);
		await expect(access.security.complete(next, keyB, issued.codes[0])).rejects.toThrow(
			"unused code",
		);
	} finally {
		await installation.close();
		await rm(dir, { recursive: true, force: true });
	}
}, 30000);

test("rollback preserves the last code for regeneration or disable and a failed replacement preserves the old seed", async () => {
	const directory = await createOwnerDirectory();
	const install = await openInstallation(directory);
	try {
		const password = crypto.randomUUID();
		let time = Date.now();
		const access = createOwnerAccess(install, () => time);
		const claimed = await access.claim(access.rotate(), "owner", password, keyA);
		const grant = await access.security.authorize("enable", claimed.digest, password, "");
		if (grant.kind !== "candidate") throw new Error();
		const totp = new TOTP({ secret: grant.manual });
		const issued = await access.security.activate(
			"enable",
			claimed.digest,
			grant.digest,
			totp.generate({ timestamp: time }),
		);
		const replace = await access.security.authorize(
			"replace",
			issued.digest,
			password,
			issued.codes[0],
		);
		if (replace.kind !== "candidate") throw new Error();
		const nextCode = new TOTP({ secret: replace.manual }).generate({ timestamp: time });
		await install.use((db) =>
			db.run(
				sql`CREATE TRIGGER abort_session BEFORE INSERT ON session BEGIN SELECT RAISE(ABORT,'fixture rollback'); END`,
			),
		);
		await expect(
			access.security.activate("replace", issued.digest, replace.digest, nextCode),
		).rejects.toThrow();
		// Reduce the fixture to one remaining recovery code.
		const { recoveryDigest } = await import("./factors");
		const { factor } = await access.security.snapshot();
		if (!factor) throw new Error();
		const last = issued.codes[9],
			digest = recoveryDigest(install.id, factor.set_id, last);
		await install.use(async (db) => {
			await db.run(sql`DELETE FROM recovery_code WHERE digest!=${digest}`);
			await db.run(sql`UPDATE owner_factor SET remaining=1`);
		});
		for (const action of ["disable", "regenerate"] as const) {
			await expect(
				access.security.authorize(action, issued.digest, password, last),
			).rejects.toThrow();
			expect((await access.security.snapshot()).factor?.remaining).toBe(1);
		}
		await install.use((db) => db.run(sql`DROP TRIGGER abort_session`));
		time += 30000;
		const proof = await pendingSignIn(access, password, keyA);
		const signed = await access.security.complete(proof, keyA, totp.generate({ timestamp: time }));
		expect(await username(access, signed.bearer)).toBe("owner");
		const result = await access.security.authorize("disable", signed.digest, password, last);
		expect(result.kind).toBe("changed");
	} finally {
		await install.close();
		await rm(directory, { recursive: true, force: true });
	}
}, 30000);

test("the policy snapshot rejects a password-only sign-in that races activation", async () => {
	const directory = await createOwnerDirectory(),
		install = await openInstallation(directory);
	try {
		const { createAuthenticator } = await import("./authenticator");
		const password = crypto.randomUUID(),
			owner = createOwnerAccess(install);
		const session = await owner.claim(owner.rotate(), "owner", password, keyA);
		const stored = await accessStore(install, createBearers()).owner();
		if (!stored) throw new Error();
		const verified = Promise.withResolvers<void>(),
			resume = Promise.withResolvers<void>();
		const delayed = createAuthenticator(
			install,
			"http://127.0.0.1",
			Date.now,
			async () => {
				if (!(await Bun.password.verify(password, stored.password_hash))) throw new Error();
				verified.resolve();
				await resume.promise;
				return stored;
			},
			createBearers(),
		);
		const pending = delayed.signIn("owner", password, keyB);
		await verified.promise;
		const grant = await owner.security.authorize("enable", session.digest, password, "");
		if (grant.kind !== "candidate") throw new Error();
		await owner.security.activate(
			"enable",
			session.digest,
			grant.digest,
			new TOTP({ secret: grant.manual }).generate(),
		);
		resume.resolve();
		await expect(pending).rejects.toThrow("Authorization expired");
		expect(await install.use((db) => db.get(sql`SELECT count(*) AS n FROM session`))).toEqual({
			n: 1,
		});
	} finally {
		await install.close();
		await rm(directory, { recursive: true, force: true });
	}
}, 30000);

test("monotonic expiry and restart discard proofs while the factor high-water mark survives both", async () => {
	const { createAuthenticator } = await import("./authenticator");
	const directory = await createOwnerDirectory();
	let install = await openInstallation(directory),
		elapsed = 0,
		wall = 1700000010000;
	const origin = "http://127.0.0.1",
		password = crypto.randomUUID();
	try {
		const access = createOwnerAccess(install, () => wall, origin);
		const session = await access.claim(access.rotate(), "owner", password, keyA);
		const owner = await accessStore(install, createBearers()).owner();
		if (!owner) throw new Error();
		const security = createAuthenticator(
			install,
			origin,
			() => wall,
			async () => owner,
			createBearers(),
			() => elapsed,
		);
		const grant = await security.authorize("enable", session.digest, password, "");
		if (grant.kind !== "candidate") throw new Error();
		elapsed += 300000;
		await expect(
			security.activate(
				"enable",
				session.digest,
				grant.digest,
				new TOTP({ secret: grant.manual }).generate({ timestamp: wall }),
			),
		).rejects.toThrow("expired");
		const fresh = await security.authorize("enable", session.digest, password, "");
		if (fresh.kind !== "candidate") throw new Error();
		const totp = new TOTP({ secret: fresh.manual });
		const rotated = await security.activate(
			"enable",
			session.digest,
			fresh.digest,
			totp.generate({ timestamp: wall }),
		);
		const first = await security.signIn("owner", password, keyB);
		const second = await security.signIn("owner", password, keyB);
		if (first.kind !== "pending" || second.kind !== "pending") throw new Error();
		// A key's new pending sign-in replaces its earlier one.
		expect(await proofLive(install, first.token)).toBe(false);
		wall += 30000;
		const code = totp.generate({ timestamp: wall });
		const results = await Promise.allSettled([
			security.complete(second.token, keyB, code),
			security.complete(second.token, keyB, code),
		]);
		expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
		const expired = await security.signIn("owner", password, keyB);
		if (expired.kind !== "pending") throw new Error();
		elapsed += 300000;
		await expect(security.complete(expired.token, keyB, code)).rejects.toThrow("expired");
		const before = await security.signIn("owner", password, keyB);
		if (before.kind !== "pending") throw new Error();
		await install.close();
		install = await openInstallation(directory);
		const reopened = createOwnerAccess(install, () => wall, origin);
		await reopened.security.initialize();
		// The monotonic clock restarts with the runtime, so the earlier proof can never finish.
		await expect(reopened.security.complete(before.token, keyB, code)).rejects.toThrow("expired");
		const now = await pendingSignIn(reopened, password, keyB);
		await expect(reopened.security.complete(now, keyB, code)).rejects.toThrow("unused code");
		wall -= 30000;
		await expect(
			reopened.security.complete(now, keyB, totp.generate({ timestamp: wall })),
		).rejects.toThrow("unused code");
		const resumed = await reopened.resume(keyA, undefined);
		expect(resumed?.sessionId).toBe(rotated.sessionId);
	} finally {
		await install.close();
		await rm(directory, { recursive: true, force: true });
	}
}, 30000);

test("resuming a candidate requires its live session and digest at the current revision and origin", async () => {
	const directory = await createOwnerDirectory();
	const install = await openInstallation(directory);
	try {
		const password = crypto.randomUUID(),
			owner = createOwnerAccess(install);
		const session = await owner.claim(owner.rotate(), "owner", password, keyA);
		const grant = await owner.security.authorize("enable", session.digest, password, "");
		if (grant.kind !== "candidate") throw new Error("Missing enrollment.");
		const second = await owner.signIn("owner", password, keyB);
		if (second.kind !== "session") throw new Error();
		const resume = async (value: string, requested?: string) =>
			(await owner.security.settings(value, requested)).candidate;
		expect(await resume(second.digest, grant.digest)).toBeNull();
		expect(await resume(session.digest)).toBeNull();
		expect(await resume(session.digest, "f".repeat(64))).toBeNull();
		expect(await resume(session.digest, "not a digest")).toBeNull();
		const resumed = await resume(session.digest, grant.digest);
		expect(resumed?.digest === grant.digest).toBe(true);
		expect(resumed?.manual === grant.manual).toBe(true);
		await install.use((db) => db.run(sql`UPDATE owner_proof SET origin='http://other.invalid'`));
		expect(await resume(session.digest, grant.digest)).toBeNull();
		await install.use((db) =>
			db.run(sql`UPDATE owner_proof SET origin='http://127.0.0.1', expires=0`),
		);
		expect(await resume(session.digest, grant.digest)).toBeNull();
		const next = await owner.security.authorize("enable", session.digest, password, "");
		if (next.kind !== "candidate") throw new Error("Missing replacement grant.");
		// The superseded candidate stays refused.
		expect(await resume(session.digest, grant.digest)).toBeNull();
		expect(await resume(session.digest, next.digest)).not.toBeNull();
		await install.use((db) => db.run(sql`UPDATE owner_security SET revision=revision+1`));
		expect(await resume(session.digest, next.digest)).toBeNull();
	} finally {
		await install.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("a pending sign-in acts only for its browser key", async () => {
	const directory = await createOwnerDirectory();
	const install = await openInstallation(directory);
	try {
		const password = crypto.randomUUID();
		const access = createOwnerAccess(install);
		const claimed = await access.claim(access.rotate(), "owner", password, keyA);
		const grant = await access.security.authorize("enable", claimed.digest, password, "");
		if (grant.kind !== "candidate") throw new Error();
		const totp = new TOTP({ secret: grant.manual });
		const enabled = await access.security.activate(
			"enable",
			claimed.digest,
			grant.digest,
			totp.generate(),
		);
		const proofA = await pendingSignIn(access, password, keyA);
		const proofB = await pendingSignIn(access, password, keyB);
		// Another key's sign-in replaces only its own pending proof.
		expect(await proofLive(install, proofA)).toBe(true);
		const before = await attempts(install);
		// Another key's proof is refused before any factor check, so no budget is spent.
		await expect(access.security.complete(proofA, keyB, enabled.codes[0])).rejects.toThrow(
			"Authorization expired",
		);
		expect(await attempts(install)).toEqual(before);
		await access.security.cancel(proofA, keyB);
		expect(await proofLive(install, proofA)).toBe(true);
		// A candidate digest is no sign-in proof.
		const replace = await access.security.authorize(
			"replace",
			enabled.digest,
			password,
			enabled.codes[1],
		);
		if (replace.kind !== "candidate") throw new Error();
		await expect(access.security.complete(replace.digest, keyA, "000000")).rejects.toThrow(
			"Authorization expired",
		);
		// Activation needs the candidate's own session.
		await expect(
			access.security.activate(
				"replace",
				claimed.digest,
				replace.digest,
				new TOTP({ secret: replace.manual }).generate(),
			),
		).rejects.toThrow("Authorization expired");
		await access.security.cancel(proofA, keyA);
		expect(await proofLive(install, proofA)).toBe(false);
		expect(await proofLive(install, proofB)).toBe(true);
		const signed = await access.security.complete(proofB, keyB, enabled.codes[2]);
		// Each key keeps its own session.
		expect(await username(access, signed.bearer)).toBe("owner");
		expect(await username(access, enabled.bearer)).toBe("owner");
	} finally {
		await install.close();
		await rm(directory, { recursive: true, force: true });
	}
}, 30000);

test("claim, sign-in and factor mint new session and login IDs; a Security change keeps the login ID", async () => {
	const directory = await createOwnerDirectory();
	const install = await openInstallation(directory);
	try {
		const password = crypto.randomUUID();
		const access = createOwnerAccess(install);
		const ids = new Set<string>();
		const fresh = <T extends { sessionId: string; loginId: string }>(issued: T) => {
			expect(ids.has(issued.sessionId) || ids.has(issued.loginId)).toBe(false);
			ids.add(issued.sessionId).add(issued.loginId);
			expect(issued.sessionId).toMatch(/^[\w-]{22}$/);
			return issued;
		};
		const claimed = fresh(await access.claim(access.rotate(), "owner", password, keyA));
		const signedIn = await access.signIn("owner", password, keyA);
		if (signedIn.kind !== "session") throw new Error();
		fresh(signedIn);
		// The key's earlier session is replaced, retiring its bearer.
		expect(await access.session(claimed.bearer)).toBeNull();
		const grant = await access.security.authorize("enable", signedIn.digest, password, "");
		if (grant.kind !== "candidate") throw new Error();
		const other = await access.signIn("owner", password, keyB);
		if (other.kind !== "session") throw new Error();
		const enabled = await access.security.activate(
			"enable",
			signedIn.digest,
			grant.digest,
			new TOTP({ secret: grant.manual }).generate(),
		);
		expect(enabled.loginId).toBe(signedIn.loginId);
		expect(enabled.sessionId === signedIn.sessionId).toBe(false);
		// Every other session is replaced by the successor.
		expect(await access.session(other.bearer)).toBeNull();
		expect(await install.use((db) => db.all(sql`SELECT public_key FROM session`))).toEqual([
			{ public_key: keyA },
		]);
		const proof = await pendingSignIn(access, password, keyB);
		fresh(await access.security.complete(proof, keyB, enabled.codes[0]));
		// A Security change from a session that no longer exists is stale.
		await expect(
			access.security.authorize("regenerate", "f".repeat(64), password, enabled.codes[1]),
		).rejects.toThrow("Authorization expired");
	} finally {
		await install.close();
		await rm(directory, { recursive: true, force: true });
	}
}, 30000);

test("replacing or signing out a session deletes its Security candidates with it", async () => {
	const directory = await createOwnerDirectory();
	const install = await openInstallation(directory);
	const candidates = () =>
		install.use((db) =>
			db.all<{ digest: string }>(sql`SELECT digest FROM owner_proof WHERE candidate IS NOT NULL`),
		);
	try {
		const password = crypto.randomUUID();
		const access = createOwnerAccess(install);
		const claimed = await access.claim(access.rotate(), "owner", password, keyA);
		const other = await access.signIn("owner", password, keyB);
		if (other.kind !== "session") throw new Error();
		const kept = await access.security.authorize("enable", other.digest, password, "");
		const replaced = await access.security.authorize("enable", claimed.digest, password, "");
		if (kept.kind !== "candidate" || replaced.kind !== "candidate") throw new Error();
		// The key signs in again: its old session's candidate goes, another key's stays.
		const again = await access.signIn("owner", password, keyA);
		if (again.kind !== "session") throw new Error();
		expect(await candidates()).toEqual([{ digest: kept.digest }]);
		await access.signOut(keyB, other.loginId);
		expect(await candidates()).toEqual([]);
	} finally {
		await install.close();
		await rm(directory, { recursive: true, force: true });
	}
});
