import { expect, test } from "bun:test";
import { connect } from "@tursodatabase/database";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/tursodatabase/database";
import { migrateInstallation } from "./migrations";

test("a recognized migration prefix is upgraded on reopen", async () => {
	const client = await connect(":memory:");
	try {
		const db = drizzle({ client });
		const first = { "20261121000000_first": "CREATE TABLE sample (id INTEGER)" };
		await migrateInstallation(db, true, first);
		await migrateInstallation(db, false, {
			...first,
			"20261122000000_second": "ALTER TABLE sample ADD COLUMN label TEXT",
		});
		await db.run(sql`INSERT INTO sample (label) VALUES ('stored')`);
		expect(await db.get(sql`SELECT label FROM sample`)).toEqual({ label: "stored" });
	} finally {
		await client.close();
	}
});

test("a failed initial migration rolls back its schema and history", async () => {
	const client = await connect(":memory:");
	try {
		const db = drizzle({ client });
		await expect(
			migrateInstallation(db, true, {
				"20261121000000_first":
					"CREATE TABLE sample (id INTEGER) --> statement-breakpoint INSERT INTO missing_fixture VALUES (1)",
			}),
		).rejects.toThrow();
		expect(await db.all(sql`SELECT name FROM sqlite_master WHERE name='sample'`)).toEqual([]);
		expect(await db.all(sql`SELECT name FROM __drizzle_migrations`)).toEqual([]);
	} finally {
		await client.close();
	}
});
