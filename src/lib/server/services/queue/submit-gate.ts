import { sql } from "drizzle-orm";
import type { ProviderId } from "../../../shared/providers/connections";
import type { Installation, InstallationTransaction } from "../../db/installation";
import { nextProviderStart, recordProviderStart, retryTime } from "../../db/provider-gate";
import type { Submission } from "../../providers/image-job";

// The balance read takes place outside this critical section. Serialize generation
// sends, file upload handoffs and their limiter observations, across all callers
// and credential revisions for this provider in the running studio.
const tails = new Map<string, Promise<void>>();

export async function withProviderSendLock<T>(
	installation: Installation,
	provider: ProviderId,
	work: () => Promise<T>,
) {
	const scope = installation.id + provider;
	const previous = tails.get(scope) ?? Promise.resolve();
	const operation = previous.then(work);
	const tail = operation.then(
		() => {},
		() => {},
	);
	tails.set(scope, tail);
	try {
		return await operation;
	} finally {
		if (tails.get(scope) === tail) tails.delete(scope);
	}
}

export function createSubmitGate(
	installation: Installation,
	now: () => number,
	random: () => number,
) {
	return async function send(
		provider: ProviderId,
		deadline: number,
		attempt: number,
		post: () => Promise<Submission>,
		reservation: {
			allowed: (tx: InstallationTransaction) => Promise<boolean>;
			blocked: (
				tx: InstallationTransaction,
				reason: "interrupted" | "expired" | "cooldown",
				until: number | null,
			) => Promise<void>;
		},
	) {
		return withProviderSendLock(installation, provider, async () => {
			const decision = await installation.use((db) =>
				db.transaction(
					async (tx) => {
						const time = now();
						if (!(await reservation.allowed(tx))) {
							await reservation.blocked(tx, "interrupted", null);
							return { blocked: "interrupted" } as const;
						}
						if (time >= deadline) {
							await reservation.blocked(tx, "expired", null);
							return { blocked: "expired" } as const;
						}
						const until = await nextProviderStart(tx, provider, "submit", time);
						if (until > time) {
							await reservation.blocked(tx, "cooldown", until);
							return { blocked: "cooldown", until } as const;
						}
						await recordProviderStart(tx, provider, "submit", time);
						return { send: true } as const;
					},
					{ behavior: "immediate" },
				),
			);
			if (decision.blocked) return decision;
			if (now() >= deadline) {
				await installation.use((db) =>
					db.transaction((tx) => reservation.blocked(tx, "expired", null), {
						behavior: "immediate",
					}),
				);
				return { blocked: "expired" } as const;
			}
			const result = await post();
			const finished = now();
			let retryAt = 0;
			if (result.kind === "throttled") {
				retryAt = submitRetryAt(result.retryAfter, finished, attempt, random);
				await installation.use((db) =>
					db.run(
						sql`UPDATE provider_gate SET submit_after=MAX(submit_after,${retryAt}) WHERE provider=${provider}`,
					),
				);
			}
			return { result, retryAt } as const;
		});
	};
}

export function retryDelay(attempt: number, random: () => number) {
	return 1_000 * 2 ** (attempt - 1) + Math.floor(random() * 1_000);
}

export function submitRetryAt(
	retryAfter: string | null,
	now: number,
	attempt: number,
	random: () => number,
) {
	return Math.max(retryTime(retryAfter, now), now + retryDelay(attempt, random));
}
