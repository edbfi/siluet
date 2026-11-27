/**
 * Derived Poyo.ai image rows (docs/SPEC-catalog-engine.md "Claims and replay" and "Access
 * refusals"). A claim stores the job's recoverable contract as JSON, so it dispatches, recovers
 * and saves from storage after a re-pin removes its row; a NULL contract keeps the shipped
 * adapter paths. A confirmed permission refusal is kept once per provider, model and credential
 * revision. Named at merge time (D3); G9's inventory migration sorts after it.
 */
export const imageContractMigrationName = "20261129120000_image_contract";

export const imageContractMigration = [
	"ALTER TABLE image_job ADD COLUMN contract TEXT",
	`CREATE TABLE model_refusal (
		provider TEXT NOT NULL CHECK (provider IN ('poyo', 'toapis')),
		model TEXT NOT NULL,
		credential_revision INTEGER NOT NULL,
		refused_at INTEGER NOT NULL,
		job_id TEXT NOT NULL,
		PRIMARY KEY (provider, model, credential_revision)
	)`,
].join("\n--> statement-breakpoint\n");
