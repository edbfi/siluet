import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { accessStore } from "../../db/access-store";
import { type Installation, openInstallation } from "../../db/installation";
import { createOwnerAccess } from "./access";

let directory: string;
let install: Installation;
let time: number;
let auth: ReturnType<typeof createOwnerAccess>;
const password = "a sensible local passphrase";
beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), "siluet-owner-"));
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
	const cookie = await auth.claim(token, "owner", password);
	expect(await auth.session(cookie)).toBe("owner");
	await expect(auth.claim(token, "other", password)).rejects.toThrow();
	await auth.signOut(cookie);
	expect(await auth.session(cookie)).toBeNull();
	await expect(auth.signIn("owner", "wrong")).rejects.toThrow();
	const next = await auth.signIn("owner", password);
	time += 7 * 86400000;
	expect(await auth.session(next)).toBeNull();
});
test("an expired token is rejected; a form error leaves the next token usable", async () => {
	const old = auth.rotate();
	time += 15 * 60000;
	await expect(auth.claim(old, "owner", password)).rejects.toMatchObject({ status: 403 });
	const current = auth.rotate();
	await expect(auth.claim(current, "owner", "short")).rejects.toMatchObject({ status: 400 });
	expect(await auth.session(await auth.claim(current, "owner", password))).toBe("owner");
});
test("concurrent invalid tokens are throttled and the limit clears", async () => {
	const token = auth.rotate();
	await Promise.allSettled(
		Array.from({ length: 5 }, () => auth.claim("invalid", "owner", password)),
	);
	await expect(auth.claim(token, "owner", password)).rejects.toMatchObject({ status: 429 });
	time += 5 * 60000;
	expect(await auth.session(await auth.claim(token, "owner", password))).toBe("owner");
});

test("two connections competing to claim create one owner and one session", async () => {
	const otherInstall = await openInstallation(directory);
	try {
		const other = createOwnerAccess(otherInstall);
		const results = await Promise.allSettled([
			auth.claim(auth.rotate(), "first", password),
			other.claim(other.rotate(), "second", password),
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
	await expect(auth.claim(claimToken, "owner", password)).rejects.toThrow();
	expect(await install.hasOwner()).toBe(false);
	await install.use((db) => db.run(sql`DROP TRIGGER abort_session`));
	expect(await auth.session(await auth.claim(claimToken, "owner", password))).toBe("owner");
});
test("an active session expires after 30 days and sign-in throttling is temporary", async () => {
	const session = await auth.claim(auth.rotate(), "owner", password);
	for (let day = 1; day <= 30; day++) {
		time += 86400000;
		expect(await auth.session(session)).toBe(day === 30 ? null : "owner");
	}
	for (let i = 0; i < 10; i++)
		await expect(auth.signIn("unknown", password)).rejects.toThrow("Check your username");
	await expect(auth.signIn("owner", password)).rejects.toThrow("Try again");
	time += 300000;
	expect(await auth.session(await auth.signIn("owner", password))).toBe("owner");
});

test("an active session is still usable after closing and reopening storage", async () => {
	const cookie = await auth.claim(auth.rotate(), "owner", password);
	await install.close();
	install = await openInstallation(directory);
	expect(await createOwnerAccess(install, () => time).session(cookie)).toBe("owner");
});

test("a token invalidated at commit rolls back both owner and session", async () => {
	let checks = 0;
	await expect(
		accessStore(install).claim("owner", "unused", "fixture", time, () => {
			if (++checks === 2) throw new Error("Token expired");
		}),
	).rejects.toThrow("Token expired");
	expect(await install.hasOwner()).toBe(false);
	expect(await install.use((db) => db.all(sql`SELECT digest FROM session`))).toEqual([]);
});
