import { sql } from "drizzle-orm";
import { AccessError, RetryableFactorError, recoverMessage } from "../services/owner/access-error";
import type { Installation, OwnerTransaction } from "./installation";
import { transact } from "./security-state";

export async function openFactorBudget(install: Installation, monotonic = () => performance.now()) {
	const anchor = monotonic();
	const base = await transact(install, async (tx) => {
		const row = await tx.get<{ elapsed: number }>(
			sql`SELECT elapsed FROM factor_budget WHERE singleton=1`,
		);
		if (!row) throw new Error("Factor budget unavailable.");
		const abandoned = await tx.all(
			sql`UPDATE factor_attempt SET finished=${row.elapsed} WHERE finished IS NULL RETURNING id`,
		);
		await tx.run(sql`UPDATE factor_budget SET failures=failures+${abandoned.length}`);
		await tx.run(sql`DELETE FROM owner_proof`);
		return row.elapsed;
	});
	const now = () => base + Math.max(0, Math.floor(monotonic() - anchor));
	async function touch(tx: OwnerTransaction) {
		const elapsed = now();
		await tx.run(sql`UPDATE factor_budget SET elapsed=max(elapsed,${elapsed})`);
		return elapsed;
	}
	return {
		now,
		async reserve(validate: (tx: OwnerTransaction) => Promise<void>) {
			const result = await transact(install, async (tx) => {
				await validate(tx);
				const t = await touch(tx);
				await tx.run(sql`DELETE FROM factor_attempt WHERE finished<=${t - 300000}`);
				const row = await tx.get<{
					failures: number;
					active: number;
					total: number;
					earliest: number | null;
				}>(
					sql`SELECT failures,(SELECT count(*) FROM factor_attempt WHERE finished IS NULL) AS active,(SELECT count(*) FROM factor_attempt) AS total,(SELECT min(finished) FROM factor_attempt) AS earliest FROM factor_budget WHERE singleton=1`,
				);
				if (!row) throw new Error("Factor budget unavailable.");
				if (row.failures + row.active >= 100) return new AccessError(recoverMessage, 429);
				if (row.total >= 5)
					return new RetryableFactorError(
						`Too many codes. Retry in ${Math.max(1, Math.ceil(((row.earliest ?? t) + 300000 - t) / 1000))} seconds.`,
						429,
					);
				const id = crypto.randomUUID();
				await tx.run(sql`INSERT INTO factor_attempt VALUES(${id},NULL)`);
				return id;
			});
			if (result instanceof AccessError) throw result;
			return result;
		},
		async success(tx: OwnerTransaction, id: string, reset: boolean) {
			await touch(tx);
			if (
				!(await tx.get(
					sql`DELETE FROM factor_attempt WHERE id=${id} AND finished IS NULL RETURNING id`,
				))
			)
				throw new Error("Factor attempt expired.");
			if (reset) await tx.run(sql`UPDATE factor_budget SET failures=0`);
		},
		async failure(id: string) {
			return transact(install, async (tx) => {
				const t = await touch(tx);
				if (
					await tx.get(
						sql`UPDATE factor_attempt SET finished=${t} WHERE id=${id} AND finished IS NULL RETURNING id`,
					)
				)
					return (
						(
							await tx.get<{ failures: number }>(
								sql`UPDATE factor_budget SET failures=failures+1 RETURNING failures`,
							)
						)?.failures ?? 0
					);
				return 0;
			});
		},
	};
}
