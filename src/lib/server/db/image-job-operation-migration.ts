// Legacy jobs have no recorded operation. New claims resolve the exact key in
// the released registry. Storage accepts canonical identifiers from later adapters.
export const imageJobOperationMigration = `ALTER TABLE image_job ADD COLUMN operation TEXT
	CHECK (operation IS NULL OR (
		typeof(operation)='text'
		AND length(operation) BETWEEN 1 AND 64
		AND length(CAST(operation AS BLOB))=length(operation)
		AND operation NOT GLOB '*[^a-z0-9-]*'
		AND operation NOT GLOB '-*'
		AND operation NOT GLOB '*-'
		AND instr(operation,'--')=0
	));
	--> statement-breakpoint
	ALTER TABLE image_job ADD COLUMN gallery_reason TEXT
	CHECK (gallery_reason IS NULL OR (gallery_reason='unsupported-image' AND state='completed'))`;
