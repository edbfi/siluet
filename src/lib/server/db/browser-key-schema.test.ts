import { expect, test } from "bun:test";
import { connect } from "@tursodatabase/database";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/tursodatabase/database";
import { insertSession, newLogin } from "./access-store";
import { installationMigrations, migrateInstallation } from "./migrations";

const name = "20261127120000_browser_key_sessions";

test("the upgrade revokes every cookie session and proof and keeps other data", async () => {
	const client = await connect(":memory:");
	try {
		const db = drizzle({ client });
		const released = Object.fromEntries(
			Object.entries(installationMigrations).filter(([key]) => key < name),
		);
		await migrateInstallation(db, true, released);
		await db.run(sql`INSERT INTO installation VALUES (1, 'fixture', 1)`);
		await db.run(sql`INSERT INTO owner VALUES (1, 'owner', 'hash', 1)`);
		await db.run(sql`INSERT INTO session VALUES ('old-cookie', 1, 1, 1)`);
		await db.run(
			sql`INSERT INTO owner_proof VALUES ('pending', 1, 'password', 0, 0, 'http://127.0.0.1:3000', 'signin', NULL, NULL, 9)`,
		);
		await db.run(
			sql`INSERT INTO owner_proof VALUES ('candidate', 1, 'password', 0, 0, 'http://127.0.0.1:3000', 'enable', 'old-cookie', 'sealed', 9)`,
		);
		await migrateInstallation(db, false, installationMigrations);
		expect(await db.all(sql`SELECT * FROM session`)).toEqual([]);
		expect(await db.all(sql`SELECT * FROM owner_proof`)).toEqual([]);
		expect(await db.get(sql`SELECT username FROM owner`)).toEqual({ username: "owner" });
		expect(await db.get(sql`SELECT claimed FROM installation`)).toEqual({ claimed: 1 });
	} finally {
		await client.close();
	}
});

test("one session per key and unique IDs; only a sign-in proof names a key", async () => {
	const client = await connect(":memory:");
	try {
		const db = drizzle({ client });
		await migrateInstallation(db, true, installationMigrations);
		await db.run(sql`INSERT INTO owner VALUES (1, 'owner', 'hash', 1)`);
		const first = newLogin();
		await db.run(insertSession("key-a", first, 1));
		await expect(db.run(insertSession("key-a", newLogin(), 1)).execute()).rejects.toThrow();
		await expect(
			db.run(insertSession("key-b", { ...newLogin(), sessionId: first.sessionId }, 1)).execute(),
		).rejects.toThrow();
		await expect(
			db.run(insertSession("key-b", { ...newLogin(), loginId: first.loginId }, 1)).execute(),
		).rejects.toThrow();
		await db.run(insertSession("key-b", newLogin(), 1));
		const proof = (digest: string, purpose: string, key: string | null) =>
			db
				.run(sql`INSERT INTO owner_proof (digest, owner_id, method, primary_revision, revision, origin, purpose, session_digest, candidate, expires, public_key)
				VALUES (${digest}, 1, 'password', 0, 0, 'o', ${purpose}, NULL, NULL, 9, ${key})`)
				.execute();
		await proof("signin", "signin", "key-a");
		await proof("enable", "enable", null);
		await expect(proof("keyless", "signin", null)).rejects.toThrow();
		await expect(proof("keyed", "enable", "key-a")).rejects.toThrow();
	} finally {
		await client.close();
	}
});
