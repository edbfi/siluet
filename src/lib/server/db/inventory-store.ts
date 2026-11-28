// The shared ToAPIs inventory snapshot (docs/SPEC-catalog-engine.md "Shared ToAPIs inventory
// snapshot (G9)"). A check allocates a generation before it sends. Its answer writes only while
// its credential revision is still the saved one and its generation is newer than the stored
// snapshot's, so a late or superseded answer is discarded.
import { sql } from "drizzle-orm";
import type { InventoryScope } from "../../shared/providers/inventory";
import type { Installation, InstallationTransaction } from "./installation";

type Statements = Pick<InstallationTransaction, "get" | "run">;

export type InventoryWrite = {
	origin: string;
	scope: InventoryScope;
	revision: number;
	generation: number;
	checkedAt: number;
	result:
		| { outcome: "succeeded"; models: readonly string[] }
		| { outcome: "rejected" | "unavailable" };
};

/** The stored snapshot for the saved key's current revision. */
export type InventorySnapshot = {
	revision: number;
	checkedAt: number;
	outcome: "succeeded" | "rejected" | "unavailable";
	models: string[] | null;
};

/** Issues the next generation for this origin and scope. */
export async function issueGeneration(tx: Statements, origin: string, scope: InventoryScope) {
	const row = await tx.get<{
		issued: number;
	}>(sql`INSERT INTO provider_inventory_generation(provider,origin,scope,issued)
		VALUES ('toapis',${origin},${scope},1)
		ON CONFLICT(provider,origin,scope) DO UPDATE SET issued=issued+1 RETURNING issued`);
	if (!row) throw new Error("No inventory generation issued.");
	return row.issued;
}

/**
 * Replaces the snapshot in one upsert, only for the saved key's revision and a newer generation.
 * Only a write that landed prunes the snapshots of older revisions.
 */
export async function recordSnapshot(tx: Statements, write: InventoryWrite) {
	const { origin, scope, revision, generation, checkedAt, result } = write;
	const models =
		result.outcome === "succeeded" ? JSON.stringify([...new Set(result.models)].sort()) : null;
	const written =
		await tx.get(sql`INSERT INTO provider_inventory(provider,origin,scope,revision,generation,checked_at,outcome,models)
		SELECT 'toapis',${origin},${scope},${revision},${generation},${checkedAt},${result.outcome},${models}
		FROM provider_credential WHERE provider='toapis' AND revision=${revision} AND ciphertext IS NOT NULL
		ON CONFLICT(provider,origin,scope,revision) DO UPDATE SET generation=excluded.generation,
			checked_at=excluded.checked_at, outcome=excluded.outcome, models=excluded.models
		WHERE excluded.generation>provider_inventory.generation RETURNING 1`);
	if (!written) return false;
	await tx.run(sql`DELETE FROM provider_inventory
		WHERE provider='toapis' AND origin=${origin} AND scope=${scope} AND revision<${revision}`);
	return true;
}

export async function currentSnapshot(
	tx: Pick<InstallationTransaction, "get">,
	origin: string,
	scope: InventoryScope,
): Promise<InventorySnapshot | null> {
	const row = await tx.get<{
		revision: number;
		checkedAt: number;
		outcome: InventorySnapshot["outcome"];
		models: string | null;
	}>(sql`SELECT i.revision, i.checked_at AS checkedAt, i.outcome, i.models FROM provider_inventory i
		JOIN provider_credential c ON c.provider=i.provider AND c.revision=i.revision AND c.ciphertext IS NOT NULL
		WHERE i.provider='toapis' AND i.origin=${origin} AND i.scope=${scope}`);
	return row ? { ...row, models: row.models === null ? null : JSON.parse(row.models) } : null;
}

export function inventoryStore({ use }: Installation) {
	return {
		issue: (origin: string, scope: InventoryScope) =>
			use((db) =>
				db.transaction((tx) => issueGeneration(tx, origin, scope), { behavior: "immediate" }),
			),
		record: (write: InventoryWrite) =>
			use((db) => db.transaction((tx) => recordSnapshot(tx, write), { behavior: "immediate" })),
		current: (origin: string, scope: InventoryScope) =>
			use((db) => currentSnapshot(db, origin, scope)),
	};
}
