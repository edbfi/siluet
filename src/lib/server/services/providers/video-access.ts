import { sql } from "drizzle-orm";
import type { ProviderId } from "../../../shared/providers/connections";
import type { Installation } from "../../db/installation";
import type { providerStore } from "../../db/provider-store";
import { checkVideoInventory } from "../../providers/toapis/connection";
export type VideoAccessState = "eligible" | "missing" | "unverified" | "unchecked" | "disconnected";
export const videoInventoryQuery = sql`SELECT c.revision,a.checked_at,COALESCE(a.state,'unchecked') AS state
	FROM provider_credential c LEFT JOIN model_access a ON a.provider=c.provider AND a.revision=c.revision AND a.model='seedance-2-5'
	WHERE c.provider='toapis' AND c.ciphertext IS NOT NULL`;
// Poyo has no per-model entitlement probe. Settings accepted the key through its balance read.
const poyoAccessQuery = sql`SELECT revision,verified_at AS checked_at,'eligible' AS state
	FROM provider_credential WHERE provider='poyo' AND ciphertext IS NOT NULL`;
export function accessQuery(provider: ProviderId) {
	return provider === "poyo" ? poyoAccessQuery : videoInventoryQuery;
}
export const poyoAccessMessage = "Connect a balance-verified Poyo.ai key in Settings.";
export type VideoAccess = { revision: number; checked_at: number | null; state: VideoAccessState };
export const accessMessage: Record<VideoAccessState, string> = {
	eligible: "Seedance 2.5 was listed for this key.",
	missing: "ToAPIs did not list Seedance 2.5 for this key.",
	unverified: "Video inventory could not be verified. Check again in Settings.",
	unchecked: "Check ToAPIs model access.",
	disconnected: "Connect a readable ToAPIs model key in Settings.",
};
export function createVideoAccess(
	{ use }: Installation,
	store: ReturnType<typeof providerStore>,
	check = checkVideoInventory(),
) {
	let checking = false;
	let attempts: number[] = [];
	async function current(provider: ProviderId = "toapis") {
		const record = await use((db) => db.get<VideoAccess>(accessQuery(provider)));
		const access = provider === "poyo" ? "poyo-balance" : "toapis-video";
		const saved = record && (await store.credential(provider, record.revision, access));
		return { record: saved ? record : null, saved };
	}
	return {
		current,
		async check() {
			const now = Date.now();
			attempts = attempts.filter((t) => t > now - 60_000);
			if (checking || attempts.length >= 3)
				return {
					eligible: false,
					message: "Video check is busy or rate limited. Try again in a minute.",
				};
			checking = true;
			try {
				const { saved } = await current();
				if (!saved) return { eligible: false, message: accessMessage.disconnected };
				attempts.push(now);
				const result = await check(saved.key);
				const state =
					result.outcome === "accepted" ? (result.listed ? "eligible" : "missing") : "unverified";
				const row = await use((db) =>
					db.get(sql`INSERT INTO model_access(provider,model,revision,state,checked_at)
				SELECT provider,'seedance-2-5',revision,${state},${now} FROM provider_credential
				WHERE provider='toapis' AND revision=${saved.revision} AND ciphertext IS NOT NULL
				ON CONFLICT(provider,model) DO UPDATE SET revision=excluded.revision,state=excluded.state,checked_at=excluded.checked_at
				WHERE model_access.checked_at<=excluded.checked_at OR model_access.revision<>excluded.revision RETURNING revision`),
				);
				return {
					eligible: Boolean(row) && state === "eligible",
					message: row ? accessMessage[state] : "The saved connection changed. Check again.",
				};
			} finally {
				checking = false;
			}
		},
	};
}
