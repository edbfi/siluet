import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import type { StudioDatabase } from "./installation";
import { installationMigrations } from "./migrations";
import { DirectoryPolicyError } from "./private-directory";

// Fingerprint of the non-internal DDL produced by this release's locked migrations.
// Opening the exclusive recovery connection in the native recovery test qualifies this value.
const currentSchema = "58a663767dac9f3d69fe68d6fd58805510c59c9305e62f8fe4a27731743866bc";
export async function verifyRecoverySchema(db: StudioDatabase) {
	const applied = await db.all<{ name: string }>(
		sql`SELECT name FROM __drizzle_migrations ORDER BY id`,
	);
	const expected = Object.keys(installationMigrations).sort();
	if (
		applied.length > 0 &&
		applied.length < expected.length &&
		applied.every((row, i) => row.name === expected[i])
	)
		throw new DirectoryPolicyError("Start the installed version once, stop it, then run recovery.");
	if (applied.length !== expected.length || applied.some((row, i) => row.name !== expected[i]))
		throw new Error("Unrecognized migration history.");
	const schema = await db.all(
		sql`SELECT type,name,sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT GLOB 'sqlite_*' ORDER BY type,name`,
	);
	if (createHash("sha256").update(JSON.stringify(schema)).digest("hex") !== currentSchema)
		throw new Error("Unrecognized studio schema.");
	const integrity = await db.all<{ integrity_check: string }>(sql`PRAGMA integrity_check`);
	if (integrity.length !== 1 || integrity[0].integrity_check !== "ok")
		throw new Error("Damaged studio storage.");
}
