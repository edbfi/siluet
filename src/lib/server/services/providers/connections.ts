import { type ProviderId, providerIds } from "#lib/shared/providers/connections.ts";
import type { providerStore } from "../../db/provider-store";
import type { ConnectionCheck } from "../../providers/connection-check";

type MutationOutcome =
	| "connected"
	| "removed"
	| "rejected"
	| "unavailable"
	| "rate-limited"
	| "invalid"
	| "busy"
	| "superseded"
	| "storage-unavailable";

export function createProviderConnections(
	store: ReturnType<typeof providerStore>,
	checks: Record<ProviderId, ConnectionCheck>,
	elapsed = () => performance.now(),
) {
	const attempts: Record<ProviderId, number[]> = { poyo: [], toapis: [] };
	const checking = new Set<ProviderId>();
	const statuses = () => Promise.all(providerIds.map((id) => store.status(id)));

	return {
		statuses,
		async eligibleSeedreamProviders() {
			return (await statuses())
				.filter((status) => status.state === "connected" && status.seedream)
				.map(({ id }) => id);
		},
		async connect(
			provider: ProviderId,
			value: FormDataEntryValue | null,
		): Promise<MutationOutcome> {
			if (typeof value !== "string") return "invalid";
			const key = value.trim();
			if (key.length > 1024 || !/^[!-~]+$/.test(key)) return "invalid";
			if (checking.has(provider)) return "busy";
			checking.add(provider);
			try {
				const revision = await store.revision(provider);
				const now = elapsed();
				const recent = attempts[provider].filter((time) => time > now - 60_000);
				if (recent.length >= 3) return "rate-limited";
				attempts[provider] = [...recent, now];

				const checked = await checks[provider](key);
				if (checked.outcome !== "accepted") return checked.outcome;
				const saved = await store.save(provider, key, Date.now(), checked.seedream, revision);
				return saved ? "connected" : "superseded";
			} catch {
				return "storage-unavailable";
			} finally {
				checking.delete(provider);
			}
		},
		async remove(provider: ProviderId): Promise<MutationOutcome> {
			try {
				await store.remove(provider);
				return "removed";
			} catch {
				return "storage-unavailable";
			}
		},
	};
}
