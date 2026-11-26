/**
 * Still WebP in Gallery (D5, docs/SPEC-catalog-engine.md "Images and still WebP"). The rebuild
 * admits `image/webp` and copies every row. Video keeps each constraint unchanged, including
 * the 61-second ceiling.
 */
export const galleryWebpMigration = [
	"ALTER TABLE gallery_image RENAME TO old_gallery_image",
	`CREATE TABLE gallery_image (
		job_id TEXT PRIMARY KEY NOT NULL,
		state TEXT NOT NULL CHECK(state IN ('saved','unavailable','deleting')),
		mime TEXT NOT NULL CHECK(mime IN ('image/png','image/jpeg','image/webp','video/mp4')),
		width INTEGER NOT NULL, height INTEGER NOT NULL, size INTEGER NOT NULL,
		digest TEXT NOT NULL, saved_at INTEGER NOT NULL, duration REAL, file_identity TEXT,
		CHECK(mime<>'video/mp4' OR (duration IS NOT NULL AND duration>0 AND duration<=61 AND file_identity IS NOT NULL))
	)`,
	"INSERT INTO gallery_image(job_id,state,mime,width,height,size,digest,saved_at,duration,file_identity) SELECT job_id,state,mime,width,height,size,digest,saved_at,duration,file_identity FROM old_gallery_image",
	"DROP TABLE old_gallery_image",
].join("\n--> statement-breakpoint\n");
