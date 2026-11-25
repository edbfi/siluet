/**
 * Browser-key sessions ([spec](../../../../docs/SPEC-browser-key.md), D1). Cookie sessions may
 * already have reached another local port, so the upgrade revokes every session and owner
 * proof. A session now belongs to one browser key and carries non-secret session and login IDs;
 * a pending sign-in proof names the key that may finish it. Other data stays.
 */
export const browserKeyMigration = [
	"DELETE FROM owner_proof",
	"DROP TABLE session",
	`CREATE TABLE session (
		digest TEXT PRIMARY KEY NOT NULL, owner_id INTEGER NOT NULL REFERENCES owner(id),
		public_key TEXT NOT NULL UNIQUE, session_id TEXT NOT NULL UNIQUE, login_id TEXT NOT NULL UNIQUE,
		created_at INTEGER NOT NULL, last_activity INTEGER NOT NULL
	)`,
	"ALTER TABLE owner_proof ADD COLUMN public_key TEXT CHECK((purpose='signin') = (public_key IS NOT NULL))",
].join("\n--> statement-breakpoint\n");
