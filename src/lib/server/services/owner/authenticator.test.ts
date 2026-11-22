import { expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { sql } from "drizzle-orm";
import { TOTP } from "otpauth";
import { createOwnerDirectory } from "../../../../../tests/fixtures/owner-directory";
import { openInstallation } from "../../db/installation";
import { createOwnerAccess } from "./access";

test("enrollment rotates access, pending sign-in survives a failed session insert, and recovery codes succeed once", async () => {
	const dir = await createOwnerDirectory(),
		installation = await openInstallation(dir);
	try {
		const access = createOwnerAccess(installation);
		const password = crypto.randomUUID();
		const session = await access.claim(access.rotate(), "owner", password);
		const grant = await access.security.authorize("enable", session, password, "");
		if (!("manual" in grant)) throw new Error();
		const step = new TOTP({ secret: grant.manual }).generate();
		const issued = await access.security.activate("enable", session, grant.proof, step);
		expect(issued.codes).toHaveLength(10);
		expect(await access.session(session)).toBeNull();
		const pending = await access.signIn("owner", password);
		expect(pending.kind).toBe("pending");
		expect(await access.session(pending.token)).toBeNull();
		await expect(access.security.complete(pending.token, step)).rejects.toThrow("unused code");
		await installation.use((db) =>
			db.run(
				sql`CREATE TRIGGER abort_session BEFORE INSERT ON session BEGIN SELECT RAISE(ABORT,'fixture rollback'); END`,
			),
		);
		await expect(access.security.complete(pending.token, issued.codes[0])).rejects.toThrow();
		await installation.use((db) => db.run(sql`DROP TRIGGER abort_session`));
		const signed = await access.security.complete(pending.token, issued.codes[0]);
		expect(await access.session(signed)).toBe("owner");
		await expect(access.security.complete(pending.token, issued.codes[1])).rejects.toThrow();
		const next = await access.signIn("owner", password);
		await expect(access.security.complete(next.token, issued.codes[0])).rejects.toThrow(
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
		const session = await access.claim(access.rotate(), "owner", password);
		const grant = await access.security.authorize("enable", session, password, "");
		if (grant.kind !== "candidate") throw new Error();
		const totp = new TOTP({ secret: grant.manual });
		const issued = await access.security.activate(
			"enable",
			session,
			grant.proof,
			totp.generate({ timestamp: time }),
		);
		const replace = await access.security.authorize(
			"replace",
			issued.session,
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
			access.security.activate("replace", issued.session, replace.proof, nextCode),
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
				access.security.authorize(action, issued.session, password, last),
			).rejects.toThrow();
			expect((await access.security.snapshot()).factor?.remaining).toBe(1);
		}
		await install.use((db) => db.run(sql`DROP TRIGGER abort_session`));
		time += 30000;
		const proof = await access.signIn("owner", password);
		const signed = await access.security.complete(proof.token, totp.generate({ timestamp: time }));
		expect(await access.session(signed)).toBe("owner");
		const result = await access.security.authorize("disable", signed, password, last);
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
		const session = await owner.claim(owner.rotate(), "owner", password);
		const { accessStore } = await import("../../db/access-store");
		const stored = await accessStore(install).owner();
		if (!stored) throw new Error();
		const verified = Promise.withResolvers<void>(),
			resume = Promise.withResolvers<void>();
		const delayed = createAuthenticator(install, "http://127.0.0.1", Date.now, async () => {
			if (!(await Bun.password.verify(password, stored.password_hash))) throw new Error();
			verified.resolve();
			await resume.promise;
			return stored;
		});
		const pending = delayed.signIn("owner", password);
		await verified.promise;
		const grant = await owner.security.authorize("enable", session, password, "");
		if (grant.kind !== "candidate") throw new Error();
		await owner.security.activate(
			"enable",
			session,
			grant.proof,
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
	const { accessStore } = await import("../../db/access-store");
	const { createAuthenticator } = await import("./authenticator");
	const directory = await createOwnerDirectory();
	let install = await openInstallation(directory),
		elapsed = 0,
		wall = 1700000010000;
	const origin = "http://127.0.0.1",
		password = crypto.randomUUID();
	try {
		const access = createOwnerAccess(install, () => wall, origin);
		const session = await access.claim(access.rotate(), "owner", password);
		const owner = await accessStore(install).owner();
		if (!owner) throw new Error();
		const security = createAuthenticator(
			install,
			origin,
			() => wall,
			async () => owner,
			() => elapsed,
		);
		const grant = await security.authorize("enable", session, password, "");
		if (grant.kind !== "candidate") throw new Error();
		elapsed += 300000;
		await expect(
			security.activate(
				"enable",
				session,
				grant.proof,
				new TOTP({ secret: grant.manual }).generate({ timestamp: wall }),
			),
		).rejects.toThrow("expired");
		const fresh = await security.authorize("enable", session, password, "");
		if (fresh.kind !== "candidate") throw new Error();
		const totp = new TOTP({ secret: fresh.manual });
		const { session: rotated } = await security.activate(
			"enable",
			session,
			fresh.proof,
			totp.generate({ timestamp: wall }),
		);
		const first = await security.signIn("owner", password);
		const second = await security.signIn("owner", password, first.token);
		expect(await security.pending(first.token)).toBe(false);
		wall += 30000;
		const code = totp.generate({ timestamp: wall });
		const results = await Promise.allSettled([
			security.complete(second.token, code),
			security.complete(second.token, code),
		]);
		expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
		const expired = await security.signIn("owner", password);
		elapsed += 300000;
		expect(await security.pending(expired.token)).toBe(false);
		const before = await security.signIn("owner", password);
		await install.close();
		install = await openInstallation(directory);
		const reopened = createOwnerAccess(install, () => wall, origin);
		await reopened.security.initialize();
		expect(await reopened.security.pending(before.token)).toBe(false);
		const now = await reopened.signIn("owner", password);
		await expect(reopened.security.complete(now.token, code)).rejects.toThrow("unused code");
		wall -= 30000;
		await expect(
			reopened.security.complete(now.token, totp.generate({ timestamp: wall })),
		).rejects.toThrow("unused code");
		expect(await reopened.session(rotated)).toBe("owner");
	} finally {
		await install.close();
		await rm(directory, { recursive: true, force: true });
	}
}, 30000);

test("resuming a candidate requires its live session and proof at the current revision and origin", async () => {
	const directory = await createOwnerDirectory();
	const install = await openInstallation(directory);
	try {
		const password = crypto.randomUUID(),
			owner = createOwnerAccess(install);
		const session = await owner.claim(owner.rotate(), "owner", password);
		const grant = await owner.security.authorize("enable", session, password, "");
		if (grant.kind !== "candidate") throw new Error("Missing enrollment.");
		const second = await owner.signIn("owner", password);
		const lookup = () => grant.proof;
		const resume = async (value: string, proof: () => string | undefined) =>
			(await owner.security.settings(value, proof)).candidate;
		expect(await resume(second.token, lookup)).toBeNull();
		expect(await resume(session, () => undefined)).toBeNull();
		expect(await resume(session, () => crypto.randomUUID())).toBeNull();
		const resumed = await resume(session, lookup);
		expect(resumed?.proof === grant.proof).toBe(true);
		expect(resumed?.manual === grant.manual).toBe(true);
		await install.use((db) => db.run(sql`UPDATE owner_proof SET origin='http://other.invalid'`));
		expect(await resume(session, lookup)).toBeNull();
		await install.use((db) =>
			db.run(sql`UPDATE owner_proof SET origin='http://127.0.0.1', expires=0`),
		);
		expect(await resume(session, lookup)).toBeNull();
		const next = await owner.security.authorize("enable", session, password, "");
		if (next.kind !== "candidate") throw new Error("Missing replacement grant.");
		expect(await resume(session, lookup)).toBeNull();
		await install.use((db) => db.run(sql`UPDATE owner_security SET revision=revision+1`));
		expect(await resume(session, () => next.proof)).toBeNull();
	} finally {
		await install.close();
		await rm(directory, { recursive: true, force: true });
	}
});
