import { afterEach, beforeEach, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { sql } from "drizzle-orm";
import { createOwnerDirectory } from "../../../../../tests/fixtures/owner-directory";
import { accessStore } from "../../db/access-store";
import { type Installation, openInstallation } from "../../db/installation";
import { createOwnerAccess } from "./access";
import { createBearers } from "./bearers";

let directory: string;
let install: Installation;
let time: number;
let auth: ReturnType<typeof createOwnerAccess>;
const password = "a sensible local passphrase";
const key = "browser-key-a";
const user = (session: { username: string } | null) => session?.username ?? null;
beforeEach(async () => {
	directory = await createOwnerDirectory();
	install = await openInstallation(directory);
	time = Date.now();
	auth = createOwnerAccess(install, () => time);
});
afterEach(async () => {
	await install.close();
	await rm(directory, { recursive: true, force: true });
});
test("claim is single-use and sessions are revocable and time bounded", async () => {
	const token = auth.rotate();
	const claimed = await auth.claim(token, "owner", password, key);
	expect(user(await auth.session(claimed.bearer))).toBe("owner");
	await expect(auth.claim(token, "other", password, "browser-key-b")).rejects.toThrow();
	expect(await auth.signOut(key, claimed.loginId)).toBe("revoked");
	expect(await auth.session(claimed.bearer)).toBeNull();
	await expect(auth.signIn("owner", "wrong", key)).rejects.toThrow();
	const next = await auth.signIn("owner", password, key);
	if (next.kind !== "session") throw new Error("Expected a session.");
	time += 7 * 86400000;
	expect(await auth.session(next.bearer)).toBeNull();
});
test("an expired token is rejected; a form error leaves the next token usable", async () => {
	const old = auth.rotate();
	time += 15 * 60000;
	await expect(auth.claim(old, "owner", password, key)).rejects.toMatchObject({ status: 403 });
	const current = auth.rotate();
	await expect(auth.claim(current, "owner", "short", key)).rejects.toMatchObject({ status: 400 });
	const claimed = await auth.claim(current, "owner", password, key);
	expect(user(await auth.session(claimed.bearer))).toBe("owner");
});
test("concurrent invalid tokens are throttled and the limit clears", async () => {
	const token = auth.rotate();
	await Promise.allSettled(
		Array.from({ length: 5 }, () => auth.claim("invalid", "owner", password, key)),
	);
	await expect(auth.claim(token, "owner", password, key)).rejects.toMatchObject({ status: 429 });
	time += 5 * 60000;
	const claimed = await auth.claim(token, "owner", password, key);
	expect(user(await auth.session(claimed.bearer))).toBe("owner");
});

test("two connections competing to claim create one owner and one session", async () => {
	const otherInstall = await openInstallation(directory);
	try {
		const other = createOwnerAccess(otherInstall);
		const results = await Promise.allSettled([
			auth.claim(auth.rotate(), "first", password, key),
			other.claim(other.rotate(), "second", password, "browser-key-b"),
		]);
		expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
		expect(await install.use((db) => db.get(sql`SELECT COUNT(*) AS n FROM session`))).toEqual({
			n: 1,
		});
	} finally {
		await otherInstall.close();
	}
});
test("a failed session insert rolls back claim and allows the same token to be retried", async () => {
	const claimToken = auth.rotate();
	await install.use((db) =>
		db.run(
			sql`CREATE TRIGGER abort_session BEFORE INSERT ON session BEGIN SELECT RAISE(ABORT,'fixture failure'); END`,
		),
	);
	await expect(auth.claim(claimToken, "owner", password, key)).rejects.toThrow();
	expect(await install.hasOwner()).toBe(false);
	await install.use((db) => db.run(sql`DROP TRIGGER abort_session`));
	const claimed = await auth.claim(claimToken, "owner", password, key);
	expect(user(await auth.session(claimed.bearer))).toBe("owner");
});
test("an active session expires after 30 days and sign-in throttling is temporary", async () => {
	const session = await auth.claim(auth.rotate(), "owner", password, key);
	for (let day = 1; day <= 30; day++) {
		time += 86400000;
		// Bearers last ten minutes, so each day resumes the key's session first.
		const resumed = await auth.resume(key, undefined);
		expect(user(resumed && (await auth.session(resumed.bearer)))).toBe(day === 30 ? null : "owner");
	}
	expect(await auth.session(session.bearer)).toBeNull();
	// The right password with the wrong username fails. The other nine attempts use an
	// over-long password, which fails before Argon2 runs but still counts.
	await expect(auth.signIn("unknown", password, key)).rejects.toThrow("Check your username");
	const oversized = "x".repeat(1025);
	for (let i = 1; i < 10; i++)
		await expect(auth.signIn("owner", oversized, key)).rejects.toThrow("Check your username");
	await expect(auth.signIn("owner", password, key)).rejects.toThrow("Try again");
	time += 300000;
	const signedIn = await auth.signIn("owner", password, key);
	if (signedIn.kind !== "session") throw new Error("Expected a session.");
	expect(user(await auth.session(signedIn.bearer))).toBe("owner");
});

test("an active session is still usable after closing and reopening storage", async () => {
	await auth.claim(auth.rotate(), "owner", password, key);
	await install.close();
	install = await openInstallation(directory);
	// Bearers live in memory, so a restarted runtime resumes the key's stored session.
	const restarted = createOwnerAccess(install, () => time);
	const resumed = await restarted.resume(key, undefined);
	expect(user(resumed && (await restarted.session(resumed.bearer)))).toBe("owner");
});

test("a token invalidated at commit rolls back both owner and session", async () => {
	let checks = 0;
	await expect(
		accessStore(install, createBearers()).claim("owner", "unused", key, time, () => {
			if (++checks === 2) throw new Error("Token expired");
		}),
	).rejects.toThrow("Token expired");
	expect(await install.hasOwner()).toBe(false);
	expect(await install.use((db) => db.all(sql`SELECT digest FROM session`))).toEqual([]);
});
