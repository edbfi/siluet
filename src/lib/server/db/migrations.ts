import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/tursodatabase/wasm-migrator";
import { gallerySchema } from "./gallery-schema";
import { imageJobSchema } from "./image-job-schema";

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

export const installationMigrations = {
	...ownerMigrations,
	"20261121191912_provider_credentials": `CREATE TABLE provider_credential (
		provider TEXT PRIMARY KEY NOT NULL CHECK (provider IN ('poyo', 'toapis')),
		revision INTEGER NOT NULL DEFAULT 0,
		ciphertext TEXT,
		verified_at INTEGER,
		seedream INTEGER CHECK (seedream IN (0, 1)),
		CHECK ((ciphertext IS NULL AND verified_at IS NULL AND seedream IS NULL)
			OR (ciphertext IS NOT NULL AND verified_at IS NOT NULL AND seedream IS NOT NULL))
	);
	--> statement-breakpoint
	INSERT INTO provider_credential (provider) VALUES ('poyo'), ('toapis');`,
	"20261121223139_first_saved_image": [
		"CREATE TABLE image_review_key (singleton INTEGER PRIMARY KEY CHECK (singleton=1), secret TEXT NOT NULL);",
		"INSERT INTO image_review_key VALUES(1, lower(hex(randomblob(32))));",
		imageJobSchema,
		gallerySchema,
	].join("\n--> statement-breakpoint\n"),
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
