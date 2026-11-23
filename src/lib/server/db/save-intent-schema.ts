/**
 * Automatic Save (D9). `save_due` is a pending intent and the earliest time the worker may
 * act on it; `save_hold` stops it; `save_attempt` fences a claimed attempt and names its
 * scratch file; `save_tries` counts failed downloads. `gallery_reason` is no longer read.
 * Completed, unsaved jobs from earlier versions become pending so they download once.
 */
export const saveIntentMigration = [
	"ALTER TABLE image_job ADD COLUMN save_due INTEGER",
	"ALTER TABLE image_job ADD COLUMN save_hold TEXT CHECK(save_hold IS NULL OR save_hold IN ('removed','unsupported','webm','failed'))",
	"ALTER TABLE image_job ADD COLUMN save_attempt TEXT",
	"ALTER TABLE image_job ADD COLUMN save_tries INTEGER NOT NULL DEFAULT 0 CHECK(save_tries BETWEEN 0 AND 3)",
	"UPDATE image_job SET save_hold='unsupported' WHERE gallery_reason='unsupported-image'",
	"UPDATE image_job SET save_hold='removed' WHERE id IN (SELECT job_id FROM gallery_image WHERE state='deleting')",
	`UPDATE image_job SET save_due=0 WHERE state='completed' AND save_hold IS NULL
		AND NOT EXISTS (SELECT 1 FROM gallery_image g WHERE g.job_id=image_job.id)`,
	"DROP TABLE video_save",
].join("\n--> statement-breakpoint\n");
