import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { connect } from "@tursodatabase/database";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/tursodatabase/database";
import { migrateInstallation } from "../../../src/lib/server/db/migrations";
import { migrations37 } from "./migrations-37";

type Database = ReturnType<typeof drizzle>;

/**
 * Write a claimed installation as the #37 release (or a later pinned `history`) left it,
 * then let `populate` add rows before the current build first opens (and upgrades) it.
 */
export async function createInstallation37(
	directory: string,
	populate: (db: Database) => Promise<void> = async () => {},
	password = crypto.randomUUID(),
	history: Record<string, string> = migrations37,
) {
	const id = crypto.randomUUID();
	await writeFile(join(directory, "installation.id"), id, { mode: 0o600 });
	const client = await connect(join(directory, "studio.db"));
	try {
		const db = drizzle({ client });
		await migrateInstallation(db, true, history);
		const hash = await Bun.password.hash(password, { algorithm: "argon2id" });
		await db.run(sql`INSERT INTO installation VALUES (1, ${id}, 1)`);
		await db.run(sql`INSERT INTO owner VALUES (1, 'creator', ${hash}, 10)`);
		await populate(db);
	} finally {
		await client.close();
	}
	return { id, password };
}
