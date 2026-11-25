/**
 * Real-clip Save (D6, D9): one C2PA box and AAC priming are now accepted, so each completed,
 * unsaved video held outside the profile is re-armed once. The stored hold does not say which
 * check refused it, so every such clip downloads once more and one still refused is held again.
 * A result the provider itself reported as not a video keeps its hold.
 */
export const videoProfileRearmMigration = `UPDATE image_job SET save_hold=NULL, save_tries=0, save_due=0
	WHERE state='completed' AND save_hold='unsupported'
		AND (video_terms IS NOT NULL OR business_id IS NOT NULL)
		AND (pause_reason IS NULL OR pause_reason<>'unsupported-video-result')
		AND NOT EXISTS (SELECT 1 FROM gallery_image g WHERE g.job_id=image_job.id)`;
