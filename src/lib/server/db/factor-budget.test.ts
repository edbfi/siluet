import { expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { sql } from "drizzle-orm";
import { createOwnerDirectory } from "../../../../tests/fixtures/owner-directory";
import { openFactorBudget } from "./factor-budget";
import { openInstallation } from "./installation";
import { transact } from "./security-state";

const valid = async () => {};
test("in-flight reservations survive aging and count against both budgets after restart", async () => {
	const directory = await createOwnerDirectory();
	let install = await openInstallation(directory);
	let elapsed = 0;
	try {
		let budget = await openFactorBudget(install, () => elapsed);
		const results = await Promise.allSettled(
			Array.from({ length: 8 }, () => budget.reserve(valid)),
		);
		const reserved = results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
		expect(reserved).toHaveLength(5);
		elapsed += 300001;
		await expect(budget.reserve(valid)).rejects.toThrow("Retry");
		await budget.failure(reserved[0]);
		await transact(install, (tx) => budget.success(tx, reserved[1], true));
		await install.close();
		elapsed += 999999999;
		install = await openInstallation(directory);
		budget = await openFactorBudget(install, () => elapsed);
		const counts = () =>
			install.use((db) => db.get<{ failures: number }>(sql`SELECT failures FROM factor_budget`));
		expect((await counts())?.failures).toBe(3);
		const one = await budget.reserve(valid);
		await expect(budget.reserve(valid)).rejects.toThrow("Retry");
		await budget.failure(one);
		elapsed += 300001;
		for (let failures = 4; failures < 98; failures++) {
			if (failures % 5 === 4) elapsed += 300001;
			await budget.failure(await budget.reserve(valid));
		}
		elapsed += 300001;
		expect((await counts())?.failures).toBe(98);
		const close = await Promise.allSettled(Array.from({ length: 4 }, () => budget.reserve(valid)));
		const last = close.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
		expect(last).toHaveLength(2);
		await budget.failure(last[0]);
		await budget.failure(last[1]);
		await expect(budget.reserve(valid)).rejects.toThrow("owner:recover");
		await install.close();
		install = await openInstallation(directory);
		elapsed += 999999999;
		budget = await openFactorBudget(install, () => elapsed);
		await expect(budget.reserve(valid)).rejects.toThrow("owner:recover");
	} finally {
		await install.close();
		await rm(directory, { recursive: true, force: true });
	}
}, 30000);
