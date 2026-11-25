/**
 * Per-mode video Save limits (D6, docs/SPEC-video-save-limits.md). Each video job keeps the
 * limit it was reviewed and claimed with. Jobs queued before this version adopt their mode's
 * limit from (provider, model, operation), which names one route per released key; any other
 * video job keeps NULL and the former 12-second rule. Gallery's ceiling becomes 61 seconds,
 * the 60-second maximum plus the allowance. Completed, unsaved clips held outside the profile
 * re-arm once when they now have a limit (as the real-clip re-arm does), and a result the
 * provider reported as not a video keeps its hold.
 */
export const videoSaveLimitMigration = [
	"ALTER TABLE image_job ADD COLUMN save_seconds INTEGER CHECK(save_seconds IS NULL OR (typeof(save_seconds)='integer' AND save_seconds>0 AND (video_terms IS NOT NULL OR business_id IS NOT NULL)))",
	`UPDATE image_job SET save_seconds=CASE
		WHEN provider='toapis' AND model='seedance-2-5' AND operation IN ('text-to-video','first-frame-to-video','first-and-last-frame-to-video') THEN 30
		WHEN provider='poyo' AND model='h3-max' AND operation='text-to-video' THEN 15
	END
	WHERE video_terms IS NOT NULL OR business_id IS NOT NULL`,
	"ALTER TABLE gallery_image RENAME TO old_gallery_image",
	`CREATE TABLE gallery_image (
		job_id TEXT PRIMARY KEY NOT NULL,
		state TEXT NOT NULL CHECK(state IN ('saved','unavailable','deleting')),
		mime TEXT NOT NULL CHECK(mime IN ('image/png','image/jpeg','video/mp4')),
		width INTEGER NOT NULL, height INTEGER NOT NULL, size INTEGER NOT NULL,
		digest TEXT NOT NULL, saved_at INTEGER NOT NULL, duration REAL, file_identity TEXT,
		CHECK(mime<>'video/mp4' OR (duration IS NOT NULL AND duration>0 AND duration<=61 AND file_identity IS NOT NULL))
	)`,
	"INSERT INTO gallery_image(job_id,state,mime,width,height,size,digest,saved_at,duration,file_identity) SELECT job_id,state,mime,width,height,size,digest,saved_at,duration,file_identity FROM old_gallery_image",
	"DROP TABLE old_gallery_image",
	`UPDATE image_job SET save_hold=NULL, save_tries=0, save_due=0
		WHERE state='completed' AND save_hold='unsupported' AND save_seconds IS NOT NULL
			AND (video_terms IS NOT NULL OR business_id IS NOT NULL)
			AND (pause_reason IS NULL OR pause_reason<>'unsupported-video-result')
			AND NOT EXISTS (SELECT 1 FROM gallery_image g WHERE g.job_id=image_job.id)`,
].join("\n--> statement-breakpoint\n");
