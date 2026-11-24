import { expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { sql } from "drizzle-orm";
import { createOwnerDirectory } from "../../../../tests/fixtures/owner-directory";
import { openInstallation } from "./installation";
import { nextPoyoUploadStart } from "./poyo-upload-window";

test("the window admits a sequence only when all of its uploads fit", async () => {
	const root = await createOwnerDirectory();
	const db = await openInstallation(root);
	try {
		await db.use((tx) =>
			tx.run(sql`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<8)
				INSERT INTO poyo_upload_start SELECT 1000+i FROM n`),
		);
		const next = (needed: number) => db.use((tx) => nextPoyoUploadStart(tx, 2000, needed));
		expect(await next(1)).toBe(0);
		expect(await next(2)).toBe(0);
		// Three files need the slot that frees when the oldest of the eight starts leaves.
		expect(await next(3)).toBe(61_001);
		expect(await next(10)).toBe(61_008);
		await expect(next(0)).rejects.toThrow();
		await expect(next(11)).rejects.toThrow();
	} finally {
		await db.close();
		await rm(root, { recursive: true, force: true });
	}
});
