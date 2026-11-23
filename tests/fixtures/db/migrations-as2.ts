// The automatic Save migration released by AS2 (#58, cbf78a7), copied verbatim.
// Upgrade tests build an AS2 database from this history, independent of the current source.
import { migrations37 } from "./migrations-37";

export const migrationsAs2: Record<string, string> = {
	...migrations37,
	"20261123120000_automatic_save":
		"ALTER TABLE image_job ADD COLUMN save_due INTEGER\n--> statement-breakpoint\nALTER TABLE image_job ADD COLUMN save_hold TEXT CHECK(save_hold IS NULL OR save_hold IN ('removed','unsupported','webm','failed'))\n--> statement-breakpoint\nALTER TABLE image_job ADD COLUMN save_attempt TEXT\n--> statement-breakpoint\nALTER TABLE image_job ADD COLUMN save_tries INTEGER NOT NULL DEFAULT 0 CHECK(save_tries BETWEEN 0 AND 3)\n--> statement-breakpoint\nUPDATE image_job SET save_hold='unsupported' WHERE gallery_reason='unsupported-image'\n--> statement-breakpoint\nUPDATE image_job SET save_hold='unsupported' WHERE state='completed'\n\t\tAND pause_reason='unsupported-video-result'\n\t\tAND NOT EXISTS (SELECT 1 FROM gallery_image g WHERE g.job_id=image_job.id)\n--> statement-breakpoint\nUPDATE image_job SET save_hold='removed' WHERE id IN (SELECT job_id FROM gallery_image WHERE state='deleting')\n--> statement-breakpoint\nUPDATE image_job SET save_due=0 WHERE state='completed' AND save_hold IS NULL\n\t\tAND NOT EXISTS (SELECT 1 FROM gallery_image g WHERE g.job_id=image_job.id)\n--> statement-breakpoint\nDROP TABLE video_save",
};
