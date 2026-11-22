import { sql } from "drizzle-orm";
import type { Installation } from "./installation";
import { transact } from "./security-state";
export async function recoverOwner(
	installation: Installation,
	hash: string,
	ensureActive: () => void,
) {
	if (installation.mode !== "recovery") throw new Error("Exclusive recovery lock required.");
	await transact(installation, async (tx) => {
		ensureActive();
		if (!(await tx.get(sql`UPDATE owner SET password_hash=${hash} WHERE id=1 RETURNING id`)))
			throw new Error("Owner unavailable.");
		if (
			!(await tx.get(
				sql`UPDATE owner_security SET enabled=0,recovery_required=0,revision=revision+1,primary_revision=primary_revision+1 WHERE singleton=1 RETURNING singleton`,
			))
		)
			throw new Error("Security state unavailable.");
		await tx.run(sql`DELETE FROM owner_factor`);
		await tx.run(sql`DELETE FROM recovery_code`);
		await tx.run(sql`DELETE FROM owner_proof`);
		await tx.run(sql`DELETE FROM session`);
		await tx.run(sql`DELETE FROM auth_attempt`);
		await tx.run(sql`DELETE FROM factor_attempt`);
		if (
			!(await tx.get(
				sql`UPDATE factor_budget SET failures=0,elapsed=0 WHERE singleton=1 RETURNING singleton`,
			))
		)
			throw new Error("Factor budget unavailable.");
		ensureActive();
	});
}
