export const videoMigration = [
	"ALTER TABLE image_job ADD COLUMN business_id TEXT",
	"CREATE UNIQUE INDEX video_business_id ON image_job(business_id)",
	"ALTER TABLE image_job ADD COLUMN video_poll_deadline INTEGER CHECK(video_poll_deadline IS NULL OR (business_id IS NOT NULL AND task_id IS NOT NULL AND video_poll_deadline=submission_recorded_at+600000))",
	"ALTER TABLE image_job ADD COLUMN video_progress INTEGER CHECK(video_progress BETWEEN 0 AND 100)",
	"ALTER TABLE image_job ADD COLUMN video_terms TEXT",
	"ALTER TABLE image_job ADD COLUMN video_observation_id TEXT",
	`CREATE TABLE model_access (
		provider TEXT NOT NULL, model TEXT NOT NULL, revision INTEGER NOT NULL,
		state TEXT NOT NULL CHECK(state IN ('eligible','missing','unverified')), checked_at INTEGER NOT NULL,
		PRIMARY KEY(provider,model)
	)`,
	"ALTER TABLE gallery_image RENAME TO old_gallery_image",
	`CREATE TABLE gallery_image (
		job_id TEXT PRIMARY KEY NOT NULL,
		state TEXT NOT NULL CHECK(state IN ('saved','unavailable','deleting')),
		mime TEXT NOT NULL CHECK(mime IN ('image/png','image/jpeg','video/mp4')),
		width INTEGER NOT NULL, height INTEGER NOT NULL, size INTEGER NOT NULL,
		digest TEXT NOT NULL, saved_at INTEGER NOT NULL, duration REAL, file_identity TEXT,
		CHECK(mime<>'video/mp4' OR (duration IS NOT NULL AND duration>0 AND duration<=12 AND file_identity IS NOT NULL))
	)`,
	"INSERT INTO gallery_image(job_id,state,mime,width,height,size,digest,saved_at) SELECT * FROM old_gallery_image",
	"DROP TABLE old_gallery_image",
	"CREATE TABLE video_save (singleton INTEGER PRIMARY KEY CHECK(singleton=1), job_id TEXT NOT NULL, token TEXT NOT NULL, pid INTEGER NOT NULL, runtime TEXT NOT NULL, cancelled INTEGER NOT NULL DEFAULT 0 CHECK(cancelled IN (0,1)))",
].join("\n--> statement-breakpoint\n");
