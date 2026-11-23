import { afterEach, beforeEach, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { sql } from "drizzle-orm";
import { createOwnerDirectory } from "../../../../tests/fixtures/owner-directory";
import { type Installation, openInstallation } from "./installation";
import { nextProviderStart, recordProviderStart, submitCooldown } from "./provider-gate";

let directory: string;
let installation: Installation;
const now = 1_800_000_000_000;

beforeEach(async () => {
	directory = await createOwnerDirectory();
	installation = await openInstallation(directory);
});
afterEach(async () => {
	await installation.close();
	await rm(directory, { recursive: true, force: true });
});

test("a recorded start can be withdrawn by its row, freeing the window", async () => {
	await installation.use((db) =>
		db.transaction(async (tx) => {
			const rows = [];
			for (let i = 0; i < 5; i++) rows.push(await recordProviderStart(tx, "toapis", "submit", now));
			expect(new Set(rows).size).toBe(5);
			expect(await nextProviderStart(tx, "toapis", "submit", now)).toBe(now + 1_000);
			await tx.run(sql`DELETE FROM provider_start WHERE rowid=${rows[4]}`);
			expect(await nextProviderStart(tx, "toapis", "submit", now)).toBe(0);
		}),
	);
});

test("the submit cooldown reads only the provider's own gate", async () => {
	await installation.use(async (db) => {
		await db.run(sql`UPDATE provider_gate SET submit_after=${now + 5} WHERE provider='poyo'`);
		expect(await submitCooldown(db, "poyo")).toBe(now + 5);
		expect(await submitCooldown(db, "toapis")).toBe(0);
	});
});
