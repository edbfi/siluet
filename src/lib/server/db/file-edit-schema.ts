import { poyoUploadWindowSchema } from "./poyo-upload-window";

const filePhases = [
	"claimed",
	"uploading",
	"uploaded",
	"editing",
	"unsent",
	"upload-unknown",
	"stored",
	"upload-rejected",
	"edit-unknown",
	"edit-recorded",
];

/**
 * Seedream edit with one local file: the Poyo.ai upload window, each file attempt's
 * dispatch owner and phase, and the owner's revisioned cleaning setting (D10),
 * on by default.
 */
export const fileEditMigration = [
	poyoUploadWindowSchema,
	"ALTER TABLE image_job ADD COLUMN file_owner TEXT",
	`ALTER TABLE image_job ADD COLUMN file_phase TEXT CHECK((file_phase IS NULL AND file_owner IS NULL)
		OR (file_owner IS NOT NULL AND file_phase IN (${filePhases.map((phase) => `'${phase}'`).join(",")})))`,
	`CREATE TABLE media_cleaning (singleton INTEGER PRIMARY KEY CHECK(singleton=1),
		enabled INTEGER NOT NULL CHECK(enabled IN (0,1)), revision INTEGER NOT NULL CHECK(revision>=0))`,
	"INSERT INTO media_cleaning VALUES(1,1,0)",
].join("\n--> statement-breakpoint\n");
