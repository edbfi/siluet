export const authenticatorSchema = [
	"CREATE TABLE owner_security (singleton INTEGER PRIMARY KEY CHECK(singleton=1), revision INTEGER NOT NULL, primary_revision INTEGER NOT NULL, enabled INTEGER NOT NULL CHECK(enabled IN (0,1)), recovery_required INTEGER NOT NULL CHECK(recovery_required IN (0,1)))",
	"INSERT INTO owner_security VALUES(1,0,0,0,0)",
	"CREATE TABLE owner_factor (singleton INTEGER PRIMARY KEY CHECK(singleton=1), id TEXT NOT NULL, envelope TEXT NOT NULL, used_step INTEGER NOT NULL, set_id TEXT NOT NULL, remaining INTEGER NOT NULL CHECK(remaining BETWEEN 0 AND 10))",
	"CREATE TABLE recovery_code (digest TEXT PRIMARY KEY NOT NULL, set_id TEXT NOT NULL)",
	"CREATE TABLE owner_proof (digest TEXT PRIMARY KEY NOT NULL, owner_id INTEGER NOT NULL CHECK(owner_id=1), method TEXT NOT NULL, primary_revision INTEGER NOT NULL, revision INTEGER NOT NULL, origin TEXT NOT NULL, purpose TEXT NOT NULL, session_digest TEXT, candidate TEXT, expires INTEGER NOT NULL)",
	"CREATE TABLE factor_budget (singleton INTEGER PRIMARY KEY CHECK(singleton=1), elapsed INTEGER NOT NULL, failures INTEGER NOT NULL)",
	"INSERT INTO factor_budget VALUES(1,0,0)",
	"CREATE TABLE factor_attempt (id TEXT PRIMARY KEY NOT NULL, finished INTEGER)",
].join("\n--> statement-breakpoint\n");
