/**
 * The shared ToAPIs inventory snapshot (docs/SPEC-catalog-engine.md "Shared ToAPIs inventory
 * snapshot (G9)"). One row per provider, origin, scope and credential revision holds the check
 * time, the outcome and, for a success, the sorted exact IDs as one JSON array, so one upsert
 * replaces the whole snapshot. A failure keeps no IDs. Generations are issued per provider,
 * origin and scope before a check sends, and a write keeps only a later generation.
 * Named at merge time (D3), after G4's image contract.
 */
export const inventoryMigrationName = "20261130120000_toapis_inventory";

export const inventoryMigration = [
	`CREATE TABLE provider_inventory (
		provider TEXT NOT NULL CHECK (provider='toapis'),
		origin TEXT NOT NULL,
		scope TEXT NOT NULL CHECK (scope IN ('image','video')),
		revision INTEGER NOT NULL,
		generation INTEGER NOT NULL CHECK (generation>0),
		checked_at INTEGER NOT NULL,
		outcome TEXT NOT NULL CHECK (outcome IN ('succeeded','rejected','unavailable')),
		models TEXT CHECK (CASE outcome WHEN 'succeeded'
			THEN COALESCE(CASE WHEN json_valid(models) THEN json_type(models)='array' END, 0)
			ELSE models IS NULL END),
		PRIMARY KEY (provider, origin, scope, revision)
	)`,
	`CREATE TABLE provider_inventory_generation (
		provider TEXT NOT NULL CHECK (provider='toapis'),
		origin TEXT NOT NULL,
		scope TEXT NOT NULL CHECK (scope IN ('image','video')),
		issued INTEGER NOT NULL CHECK (issued>0),
		PRIMARY KEY (provider, origin, scope)
	)`,
].join("\n--> statement-breakpoint\n");
