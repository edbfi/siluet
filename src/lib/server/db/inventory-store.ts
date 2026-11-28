// The shared ToAPIs inventory snapshot (docs/SPEC-catalog-engine.md "Shared ToAPIs inventory
// snapshot (G9)"). A check allocates a generation before it sends. Its answer writes only while
// its credential revision is still the saved one and its generation is newer than the stored
// snapshot's, so a late or superseded answer is discarded.
import { sql } from "drizzle-orm";
import {
	type InventoryKey,
	type InventoryScope,
	inventoryFreshMs,
	type ModelAccess,
	preSnapshotScope,
	preSnapshotVideoModel,
	resolveAccess,
} from "../../shared/providers/inventory";
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

type AccessQuery = { origin: string; scope: InventoryScope; key: InventoryKey };

/**
 * The SQL twin of `accessQueues(resolveAccess(...))` over the provider_credential row `c`: a
 * fresh snapshot for `c`'s revision lists the exact model, or the frozen pre-snapshot exception
 * holds because no snapshot exists for that revision.
 */
export function inventoryListedSql({ origin, scope, key }: AccessQuery, now: number) {
	const snapshot = sql`provider_inventory i WHERE i.provider='toapis' AND i.origin=${origin}
		AND i.scope=${scope} AND i.revision=c.revision`;
	const evidence =
		preSnapshotScope(key) !== scope
			? sql`0`
			: scope === "image"
				? sql`c.seedream=1`
				: sql`EXISTS(SELECT 1 FROM model_access a WHERE a.provider='toapis'
					AND a.model=${preSnapshotVideoModel} AND a.revision=c.revision AND a.state='eligible')`;
	return sql`(c.provider='toapis' AND c.ciphertext IS NOT NULL AND (EXISTS(SELECT 1 FROM ${snapshot}
		AND i.outcome='succeeded' AND i.checked_at<=${now} AND i.checked_at>${now - inventoryFreshMs}
		AND EXISTS(SELECT 1 FROM json_each(i.models) WHERE json_each.value=${key.model}))
		OR (NOT EXISTS(SELECT 1 FROM ${snapshot}) AND ${evidence})))`;
}

/**
 * Reads one model's access evidence, inside the caller's transaction at a claim. `readable` is
 * the revision of the key the caller decrypted, or null when none could be read.
 */
export async function inventoryAccess(
	tx: Pick<InstallationTransaction, "get">,
	{ origin, scope, key, readable }: AccessQuery & { readable: number | null },
	now: number,
): Promise<ModelAccess> {
	const row = await tx.get<{
		revision: number;
		seedream: number;
		accessRevision: number | null;
		accessState: string | null;
	}>(sql`SELECT c.revision, c.seedream, a.revision AS accessRevision, a.state AS accessState
		FROM provider_credential c LEFT JOIN model_access a ON a.provider=c.provider AND a.model=${preSnapshotVideoModel}
		WHERE c.provider='toapis' AND c.ciphertext IS NOT NULL`);
	const revision = row && row.revision === readable ? row.revision : null;
	return resolveAccess(
		key,
		scope,
		{
			revision,
			snapshot: revision === null ? null : await currentSnapshot(tx, origin, scope),
			seedream: row?.seedream === 1,
			modelAccess:
				row?.accessRevision != null && row.accessState !== null
					? { revision: row.accessRevision, state: row.accessState }
					: null,
		},
		now,
	);
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
