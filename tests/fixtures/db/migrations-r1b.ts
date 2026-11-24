// The local-file edit migration released by R1b (#59, 446f584), copied verbatim.
// Upgrade tests build an R1b database from this history, independent of the current source.
import { migrationsAs2 } from "./migrations-as2";

export const migrationsR1b: Record<string, string> = {
	...migrationsAs2,
	"20261123180000_seedream_file_edit":
		"CREATE TABLE poyo_upload_start (started INTEGER NOT NULL)\n--> statement-breakpoint\nALTER TABLE image_job ADD COLUMN file_owner TEXT\n--> statement-breakpoint\nALTER TABLE image_job ADD COLUMN file_phase TEXT CHECK((file_phase IS NULL AND file_owner IS NULL)\n\t\tOR (file_owner IS NOT NULL AND file_phase IN ('claimed','uploading','uploaded','editing','unsent','upload-unknown','stored','upload-rejected','edit-unknown','edit-recorded')))\n--> statement-breakpoint\nCREATE TABLE media_cleaning (singleton INTEGER PRIMARY KEY CHECK(singleton=1),\n\t\tenabled INTEGER NOT NULL CHECK(enabled IN (0,1)), revision INTEGER NOT NULL CHECK(revision>=0))\n--> statement-breakpoint\nINSERT INTO media_cleaning VALUES(1,1,0)",
};
