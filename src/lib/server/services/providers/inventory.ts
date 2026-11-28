// Check again and the automatic Review check for the shared ToAPIs inventory snapshot
// (docs/SPEC-catalog-engine.md "Shared ToAPIs inventory snapshot (G9)").
import { sql } from "drizzle-orm";
import { seedreamRoutes } from "../../../shared/media-catalog/registry";
import {
	type InventoryKey,
	type InventoryScope,
	isFresh,
	type ModelAccess,
	preSnapshotVideoModel,
} from "../../../shared/providers/inventory";
import type { Installation } from "../../db/installation";
import {
	currentSnapshot,
	inventoryAccess,
	issueGeneration,
	recordSnapshot,
} from "../../db/inventory-store";
import type { providerStore } from "../../db/provider-store";
import type { CheckFetch } from "../../providers/connection-check";
import { readModelList } from "../../providers/toapis/model-list";

export type InventoryCheck =
	| { outcome: "recorded"; result: "succeeded" | "rejected" | "unavailable"; checkedAt: number }
	/** An automatic check could not reach ToAPIs. Nothing was recorded. */
	| { outcome: "skipped" }
	| { outcome: "rate-limited"; retryAfter: number }
	| { outcome: "disconnected" }
	/** The key changed, or a newer check answered first. Nothing was recorded. */
	| { outcome: "superseded" };

const limit = 3;
const windowMs = 60_000;

export type InventoryOptions = {
	read?: CheckFetch;
	origin?: string;
	/** The check time recorded in a snapshot. */
	now?: () => number;
	/** The monotonic clock of the rate limit. */
	elapsed?: () => number;
};

export function createInventory(
	installation: Installation,
	store: Pick<ReturnType<typeof providerStore>, "credential">,
	{
		read = fetch,
		origin = seedreamRoutes.toapis.origin,
		now = Date.now,
		elapsed = () => performance.now(),
	}: InventoryOptions = {},
) {
	const list = readModelList(read, { origin });
	// Check again and the automatic check share three requests a minute per origin and scope.
	const sent: Record<InventoryScope, number[]> = { image: [], video: [] };
	const inFlight = new Map<string, Promise<InventoryCheck>>();
	const saved = () => store.credential("toapis", undefined, "toapis-video");

	async function send(
		scope: InventoryScope,
		key: { revision: number; key: string },
		automatic: boolean,
	): Promise<InventoryCheck> {
		const generation = await installation.use((db) =>
			db.transaction((tx) => issueGeneration(tx, origin, scope), { behavior: "immediate" }),
		);
		const answer = await list(key.key, scope);
		if (answer.outcome === "unreachable" && automatic) return { outcome: "skipped" };
		const result =
			answer.outcome === "succeeded"
				? answer
				: ({ outcome: answer.outcome === "rejected" ? "rejected" : "unavailable" } as const);
		const checkedAt = now();
		const written = await installation.use((db) =>
			db.transaction(
				async (tx) => {
					const landed = await recordSnapshot(tx, {
						origin,
						scope,
						revision: key.revision,
						generation,
						checkedAt,
						result,
					});
					// The shipped video claim reads this record until it reads the snapshot.
					if (landed && scope === "video") {
						const state =
							result.outcome !== "succeeded"
								? "unverified"
								: result.models.includes(preSnapshotVideoModel)
									? "eligible"
									: "missing";
						await tx.run(sql`INSERT INTO model_access(provider,model,revision,state,checked_at)
							VALUES('toapis',${preSnapshotVideoModel},${key.revision},${state},${checkedAt})
							ON CONFLICT(provider,model) DO UPDATE SET revision=excluded.revision,state=excluded.state,checked_at=excluded.checked_at`);
					}
					return landed;
				},
				{ behavior: "immediate" },
			),
		);
		return written
			? { outcome: "recorded", result: result.outcome, checkedAt }
			: { outcome: "superseded" };
	}

	/** One check of a scope's list. An automatic check joins one in flight for the same key revision. */
	async function check(
		scope: InventoryScope,
		mode: "manual" | "automatic" = "manual",
	): Promise<InventoryCheck> {
		const key = await saved();
		if (!key) return { outcome: "disconnected" };
		const id = `${origin}\n${scope}\n${key.revision}`;
		const joined = inFlight.get(id);
		if (joined && mode === "automatic") return joined;
		const time = elapsed();
		sent[scope] = sent[scope].filter((at) => at > time - windowMs);
		if (sent[scope].length >= limit)
			return {
				outcome: "rate-limited",
				retryAfter: Math.ceil((sent[scope][0] + windowMs - time) / 1000),
			};
		sent[scope].push(time);
		const work = send(scope, key, mode === "automatic");
		inFlight.set(id, work);
		try {
			return await work;
		} finally {
			if (inFlight.get(id) === work) inFlight.delete(id);
		}
	}

	async function access(key: InventoryKey, scope: InventoryScope): Promise<ModelAccess> {
		const readable = (await saved())?.revision ?? null;
		return installation.use((db) => inventoryAccess(db, { origin, scope, key, readable }, now()));
	}

	return {
		origin,
		check,
		access,
		/** The saved key's snapshot of a scope and whether it is fresh, for Settings. */
		async snapshot(scope: InventoryScope) {
			const readable = await saved();
			const time = now();
			const snapshot = readable
				? await installation.use((db) => currentSnapshot(db, origin, scope))
				: null;
			return snapshot?.revision === readable?.revision && snapshot
				? { ...snapshot, fresh: isFresh(snapshot.checkedAt, time) }
				: null;
		},
		/**
		 * The access a Review shows. Only a stale successful snapshot gets one automatic check, within
		 * the scope's limit; a missing or failed snapshot keeps the manual Check again.
		 */
		async review(key: InventoryKey, scope: InventoryScope) {
			const current = await access(key, scope);
			if (current.state !== "stale") return { access: current, skipped: false };
			const checked = await check(scope, "automatic");
			return {
				access: checked.outcome === "recorded" ? await access(key, scope) : current,
				skipped: checked.outcome === "skipped",
			};
		},
	};
}
export type Inventory = ReturnType<typeof createInventory>;
