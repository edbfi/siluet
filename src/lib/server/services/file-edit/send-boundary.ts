import { sql } from "drizzle-orm";
import type { ProviderId } from "../../../shared/providers/connections";
import type { Installation, InstallationTransaction } from "../../db/installation";
import { nextProviderStart, recordProviderStart, submitCooldown } from "../../db/provider-gate";
import { withProviderSendLock } from "../queue/submit-gate";

export function fileSendBoundary<T, const Stop extends { reason: string } = never>(
	db: Installation,
	provider: ProviderId,
	kind: "upload" | "edit",
	clock: () => number,
	mark: (tx: InstallationTransaction, time: number) => Promise<Stop | void>,
	send: () => Promise<T>,
	handoff?: {
		check: () => Stop | { reason: "destination" } | undefined;
		undo: (tx: InstallationTransaction, time: number) => Promise<void>;
	},
) {
	return withProviderSendLock(db, provider, () =>
		db.use(async (conn) => {
			const rollback = Symbol();
			let refused: ReturnType<NonNullable<typeof handoff>["check"]>;
			let start: number | undefined;
			let time = 0;
			const stop = await conn
				.transaction(
					async (tx) => {
						time = clock();
						const until =
							kind === "edit"
								? await nextProviderStart(tx, provider, "submit", time)
								: await submitCooldown(tx, provider);
						if (until > time) return { reason: "cooldown", until } as const;
						refused = handoff?.check();
						if (refused) return refused;
						const blocked = await mark(tx, time);
						if (blocked) return blocked;
						if (kind === "edit") start = await recordProviderStart(tx, provider, "submit", time);
						refused = handoff?.check();
						if (refused) throw rollback;
					},
					{ behavior: "immediate" },
				)
				.catch((error) => {
					if (error === rollback && refused) return refused;
					throw error;
				});
			if (stop) return { stop };
			// Hold this connection through synchronous transport handoff. No other
			// reader or writer can observe a live marker for a positively unsent POST.
			if (!handoff) return { receipt: send() };
			refused = handoff.check();
			if (!refused) {
				const receipt = send();
				refused = handoff.check();
				if (!refused) return { receipt };
				void receipt.catch(() => {});
			}
			await conn.transaction(
				async (tx) => {
					if (start !== undefined)
						await tx.run(sql`DELETE FROM provider_start WHERE rowid=${start}`);
					await handoff.undo(tx, time);
				},
				{ behavior: "immediate" },
			);
			return { stop: refused };
		}),
	);
}

// Enqueue the observed throttle on the same connection as send-start decisions.
// Waiting for the ordinary send's *receipt* lock would put this write behind already queued sends.
export async function recordEditCooldown(db: Installation, provider: ProviderId, until: number) {
	await db.use((tx) =>
		tx.run(
			sql`UPDATE provider_gate SET submit_after=MAX(submit_after,${until}) WHERE provider=${provider}`,
		),
	);
}
