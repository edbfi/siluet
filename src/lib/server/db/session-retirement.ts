import { type SQL, sql } from "drizzle-orm";
import type { Installation, OwnerTransaction } from "./installation";

const retiring = new WeakMap<OwnerTransaction, Set<string>>();

/**
 * Run `work` in an immediate transaction. After commit, in the same `install.use` turn,
 * retire the sessions it removed, then run `afterCommit`, so a bearer it registers for a
 * new session is dropped by any later retirement.
 */
export function ownerTransaction<T, R = T>(
	install: Installation,
	work: (tx: OwnerTransaction) => Promise<T>,
	afterCommit?: (result: T) => R,
): Promise<R> {
	return install.use(async (db) => {
		const digests = new Set<string>();
		const result = await db.transaction(
			async (tx) => {
				if (install.retireSessions) retiring.set(tx, digests);
				try {
					return await work(tx);
				} finally {
					retiring.delete(tx);
				}
			},
			{ behavior: "immediate" },
		);
		// Abort readers in commit order. The stage store schedules filesystem cleanup independently.
		if (digests.size) install.retireSessions?.(digests);
		return afterCommit ? afterCommit(result) : (result as unknown as R);
	});
}

export async function deleteOwnerSessions(tx: OwnerTransaction, where: SQL = sql`1`) {
	const rows = await tx.all<{ digest: string }>(
		sql`DELETE FROM session WHERE ${where} RETURNING digest`,
	);
	const digests = retiring.get(tx);
	if (digests) for (const row of rows) digests.add(row.digest);
	return rows.length > 0;
}

export async function requireOwnerRecovery(tx: OwnerTransaction) {
	await tx.run(sql`UPDATE owner_security SET recovery_required=1 WHERE singleton=1`);
	const digests = retiring.get(tx);
	if (digests)
		for (const row of await tx.all<{ digest: string }>(sql`SELECT digest FROM session`))
			digests.add(row.digest);
}
