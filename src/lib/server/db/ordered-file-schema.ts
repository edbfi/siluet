/**
 * Seedream edit with ordered files and URLs (R2). Each file slot of a file job has one
 * row whose outcome Jobs shows; `position`, `file_stop_slot` and `file_other_slot` are
 * 1-based reference positions, so URL slots have no `file_slot` row. `file_references`
 * counts every reference; the file count is the number of `file_slot` rows.
 *
 * R1b jobs get slot 1. R1b's `stored` phase merged unusable receipts with restarts after
 * a stored upload ("File uploaded"), so it maps to one `stored` slot. R1b recorded a
 * provider cooldown only as `retry_at`; those jobs gain the `cooldown` stop, before slot 1
 * when nothing was uploaded.
 */
export const orderedFileMigration = [
	`CREATE TABLE file_slot (job_id TEXT NOT NULL REFERENCES image_job(id),
		position INTEGER NOT NULL CHECK(position BETWEEN 1 AND 10),
		outcome TEXT NOT NULL CHECK(outcome IN ('unsent','uploading','stored','unusable','unknown','rejected')),
		PRIMARY KEY(job_id,position))`,
	"ALTER TABLE image_job ADD COLUMN file_references INTEGER CHECK(file_references BETWEEN 1 AND 10)",
	`ALTER TABLE image_job ADD COLUMN file_stop TEXT CHECK(file_stop IN
		('stage-changed','duplicate','expired-link','cooldown','interrupted','destination','unusable'))`,
	"ALTER TABLE image_job ADD COLUMN file_stop_slot INTEGER CHECK(file_stop_slot BETWEEN 1 AND 10)",
	"ALTER TABLE image_job ADD COLUMN file_other_slot INTEGER CHECK(file_other_slot BETWEEN 1 AND 10)",
	// Every released phase has its own arm. An unmapped phase leaves the outcome NULL and fails.
	`INSERT INTO file_slot SELECT id,1,CASE file_phase
		WHEN 'claimed' THEN 'unsent' WHEN 'unsent' THEN 'unsent'
		WHEN 'uploading' THEN 'uploading' WHEN 'upload-unknown' THEN 'unknown'
		WHEN 'upload-rejected' THEN 'rejected' WHEN 'uploaded' THEN 'stored'
		WHEN 'stored' THEN 'stored' WHEN 'editing' THEN 'stored'
		WHEN 'edit-unknown' THEN 'stored' WHEN 'edit-recorded' THEN 'stored' END
		FROM image_job WHERE file_phase IS NOT NULL`,
	`UPDATE image_job SET file_references=1,
		file_stop=CASE WHEN file_phase IN ('unsent','stored') AND retry_at IS NOT NULL THEN 'cooldown' END,
		file_stop_slot=CASE WHEN file_phase='unsent' AND retry_at IS NOT NULL THEN 1 END
		WHERE file_phase IS NOT NULL`,
].join("\n--> statement-breakpoint\n");
