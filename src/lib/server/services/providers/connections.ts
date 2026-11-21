import type { ProviderId } from "#lib/shared/providers/connections.ts";
import { ProviderKeyPolicyError } from "../../db/provider-key";
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
	| "storage-repair"
	| "storage-unavailable";

export function createProviderConnections(
	store: ReturnType<typeof providerStore>,
	checks: Record<ProviderId, ConnectionCheck>,
	elapsed = () => performance.now(),
) {
	const attempts: Record<ProviderId, number[]> = { poyo: [], toapis: [] };
	const checking = new Set<ProviderId>();
	const { statuses } = store;

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
				const now = elapsed();
				const recent = attempts[provider].filter((time) => time > now - 60_000);
				if (recent.length >= 3) return "rate-limited";

				const revision = await store.revision(provider);
				await store.checkKeyStorage();
				attempts[provider] = [...recent, elapsed()];
				const checked = await checks[provider](key);
				if (checked.outcome !== "accepted") return checked.outcome;
				const saved = await store.save(provider, key, Date.now(), checked.seedream, revision);
				return saved ? "connected" : "superseded";
			} catch (error) {
				return error instanceof ProviderKeyPolicyError ? "storage-repair" : "storage-unavailable";
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
