import { sql } from "drizzle-orm";
import type { ProviderId } from "../../../shared/providers/connections";
import type { Installation } from "../../db/installation";
import type { providerStore } from "../../db/provider-store";

// Poyo has no per-model entitlement probe. Settings accepted the key through its balance read.
export const poyoAccessQuery = sql`SELECT revision,verified_at AS checked_at,'eligible' AS state
	FROM provider_credential WHERE provider='poyo' AND ciphertext IS NOT NULL`;
export const poyoAccessMessage = "Connect a balance-verified Poyo.ai key in Settings.";
/** A Poyo.ai key's balance-verified record. ToAPIs access comes from its inventory snapshot. */
export type PoyoVideoAccess = { revision: number; checked_at: number | null; state: "eligible" };

/** The saved key a video Review or claim reads, and Poyo.ai's balance-verified record. */
export function createVideoAccess({ use }: Installation, store: ReturnType<typeof providerStore>) {
	return {
		async current(provider: ProviderId = "toapis") {
			if (provider === "toapis")
				return { record: null, saved: await store.credential("toapis", undefined, "toapis-video") };
			const record = await use((db) => db.get<PoyoVideoAccess>(poyoAccessQuery));
			const saved = record && (await store.credential("poyo", record.revision, "poyo-balance"));
			return { record: saved ? record : null, saved };
		},
	};
}
