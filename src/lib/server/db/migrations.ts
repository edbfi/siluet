import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/tursodatabase/wasm-migrator";

export const ownerMigrations = {
	"20261121000000_owner_access": `CREATE TABLE installation (
		singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
		installation_id TEXT NOT NULL, claimed INTEGER NOT NULL CHECK (claimed IN (0, 1))
	);
	--> statement-breakpoint
	CREATE TABLE owner (
		id INTEGER PRIMARY KEY CHECK (id = 1), username TEXT NOT NULL,
		password_hash TEXT NOT NULL, created_at INTEGER NOT NULL
	);
	--> statement-breakpoint
	CREATE TABLE session (
		digest TEXT PRIMARY KEY NOT NULL, owner_id INTEGER NOT NULL REFERENCES owner(id),
		created_at INTEGER NOT NULL, last_activity INTEGER NOT NULL
	);
	--> statement-breakpoint
	CREATE TABLE auth_attempt (id TEXT PRIMARY KEY NOT NULL, kind TEXT NOT NULL, started INTEGER NOT NULL);`,
};

export async function migrateInstallation(
	db: Parameters<typeof migrate>[0],
	fresh: boolean,
	migrations: Record<string, string>,
) {
	if (!fresh) {
		const names = Object.keys(migrations).sort();
		const applied = await db.all<{ name: string }>(
			sql`SELECT name FROM __drizzle_migrations ORDER BY id`,
		);
		if (!applied.length || applied.some((row, index) => row.name !== names[index]))
			throw new Error("Unrecognized installation migration history.");
	}
	await migrate(db, { migrations });
}
