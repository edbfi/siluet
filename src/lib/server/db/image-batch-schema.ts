// Request slots are the consecutive integers 1..request_count reserved by the claim.
// A job exists only once that slot reserves a particular attempt.
export const imageBatchSchema = [
	`CREATE TABLE image_batch (
		id TEXT PRIMARY KEY, binding TEXT NOT NULL, provider TEXT NOT NULL, revision INTEGER NOT NULL,
		model TEXT NOT NULL, operation TEXT NOT NULL CHECK(operation IN ('edit','generate')),
		terms_digest TEXT NOT NULL, disclosure_version TEXT NOT NULL, quote TEXT NOT NULL, accepted_unknown INTEGER NOT NULL CHECK(accepted_unknown IN (0,1)),
		request_count INTEGER NOT NULL CHECK(request_count BETWEEN 1 AND 5),
		retry_limit INTEGER NOT NULL CHECK(retry_limit BETWEEN 0 AND 3),
		created_at INTEGER NOT NULL, deadline INTEGER NOT NULL CHECK(deadline=created_at+120000),
		closed_reason TEXT, closed_at INTEGER
	)`,
	"ALTER TABLE image_job ADD COLUMN batch_id TEXT REFERENCES image_batch(id)",
	"ALTER TABLE image_job ADD COLUMN slot INTEGER CHECK(slot BETWEEN 1 AND 5)",
	"ALTER TABLE image_job ADD COLUMN attempt INTEGER CHECK(attempt BETWEEN 1 AND 4)",
	"CREATE UNIQUE INDEX image_attempt ON image_job(batch_id,slot,attempt)",
	"ALTER TABLE image_job ADD COLUMN skipped TEXT",
	"ALTER TABLE image_job ADD COLUMN retry_state TEXT",
	"ALTER TABLE image_job ADD COLUMN completion_seen INTEGER NOT NULL DEFAULT 0 CHECK(completion_seen IN (0,1))",
	"ALTER TABLE image_job ADD COLUMN transient_failure TEXT CHECK(transient_failure IN ('service_busy','request_rate_limited'))",
	"ALTER TABLE image_job ADD COLUMN retry_at INTEGER",
	"ALTER TABLE image_job ADD COLUMN throttle INTEGER NOT NULL DEFAULT 0",
	"CREATE TABLE provider_gate (provider TEXT PRIMARY KEY, submit_after INTEGER DEFAULT 0, query_after INTEGER DEFAULT 0)",
	"INSERT INTO provider_gate(provider) VALUES ('poyo'),('toapis')",
	"CREATE TABLE provider_start (provider TEXT NOT NULL, kind TEXT NOT NULL, started INTEGER NOT NULL)",
	"CREATE INDEX provider_start_window ON provider_start(provider,kind,started)",
].join("\n--> statement-breakpoint\n");
