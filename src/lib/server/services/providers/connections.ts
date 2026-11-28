import type { ProviderId } from "#lib/shared/providers/connections.ts";
import { seedreamProviderNames } from "../../../shared/image-studio/seedream-options";
import { zImageEligible } from "../../../shared/image-studio/z-image";
import { ProviderKeyPolicyError } from "../../db/provider-key";
import type { providerStore } from "../../db/provider-store";
import type { ConnectionCheck } from "../../providers/connection-check";

type MutationOutcome =
	| "connected"
	| "job-warning"
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
	store: Omit<ReturnType<typeof providerStore>, "credential" | "jobReadability">,
	checks: Record<ProviderId, ConnectionCheck>,
	elapsed = () => performance.now(),
) {
	const attempts: Record<ProviderId, number[]> = { poyo: [], toapis: [] };
	const checking = new Set<ProviderId>();
	const { statuses } = store;

	return {
		statuses,
		async imageAvailability() {
			const eligibleProviders: ProviderId[] = [];
			const unavailableProviders: string[] = [];
			const connections = await statuses();
			for (const status of connections) {
				if (status.state === "connected" && status.seedream) {
					eligibleProviders.push(status.id);
					continue;
				}
				const name = seedreamProviderNames[status.id];
				if (status.state === "connected" && status.id === "toapis") {
					unavailableProviders.push("ToAPIs did not list Seedream 5.5 for this key.");
				} else if (status.state === "disconnected") {
					unavailableProviders.push(`${name} is disconnected.`);
				} else {
					unavailableProviders.push(`Check the ${name} connection in Settings.`);
				}
			}
			return {
				eligibleProviders,
				unavailableProviders,
				zImageConnected: connections.some(zImageEligible),
			};
		},
		async connect(
			provider: ProviderId,
			value: FormDataEntryValue | null,
			warningSeen = false,
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
				const saved = await store.save(
					provider,
					key,
					Date.now(),
					checked.seedream,
					revision,
					!warningSeen,
				);
				if (saved === "job-warning") return saved;
				return saved ? "connected" : "superseded";
			} catch (error) {
				return error instanceof ProviderKeyPolicyError ? "storage-repair" : "storage-unavailable";
			} finally {
				checking.delete(provider);
			}
		},
		async remove(provider: ProviderId, warningSeen = false): Promise<MutationOutcome> {
			try {
				return (await store.remove(provider, !warningSeen)) ?? "removed";
			} catch {
				return "storage-unavailable";
			}
		},
	};
}
