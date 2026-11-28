import { expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { connect } from "@tursodatabase/database";
import { type SQL, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/tursodatabase/database";
import { createInstallation37 } from "../../../../tests/fixtures/db/installation-37";
import { createOwnerDirectory } from "../../../../tests/fixtures/owner-directory";
import { imageContractMigrationName } from "./image-contract-schema";
import { openInstallation } from "./installation";
import { inventoryMigrationName } from "./inventory-schema";
import { installationMigrations } from "./migrations";
import { currentSchema, schemaFingerprint } from "./recovery-schema";

// Only the migrations released before this one, so a later migration cannot run early.
const released = Object.fromEntries(
	Object.entries(installationMigrations).filter(([key]) => key < inventoryMigrationName),
);
const kept = [
	sql`SELECT * FROM provider_credential ORDER BY provider`,
	sql`SELECT * FROM model_access ORDER BY provider, model`,
	sql`SELECT * FROM image_job ORDER BY id`,
	sql`SELECT * FROM model_refusal ORDER BY provider, model`,
];

test("the upgrade keeps every credential, access record, job and refusal, and adds empty inventory tables", async () => {
	const directory = await createOwnerDirectory();
	try {
		await createInstallation37(
			directory,
			async (db) => {
				await db.run(sql`UPDATE provider_credential SET revision=3, ciphertext='sealed', verified_at=2,
					seedream=1 WHERE provider='toapis'`);
				await db.run(
					sql`INSERT INTO model_access VALUES ('toapis', 'seedance-2-5', 3, 'eligible', 2)`,
				);
				await db.run(sql`INSERT INTO image_job
					(id,binding,provider,revision,quote,state,model,operation,created_at,poll_deadline,contract)
					VALUES ('image','image-binding','toapis',3,'{}','submitting','doubao-seedream-5-5','text-to-image',4,120004,NULL),
					('derived','derived-binding','poyo',1,'{}','submitting','flux-dev','text-to-image',5,120005,'{"v":1}')`);
				await db.run(sql`INSERT INTO image_job
					(id,binding,provider,revision,quote,state,model,operation,created_at,poll_deadline,business_id,video_terms)
					VALUES ('video','video-binding','toapis',3,'{}','submitting','seedance-2-5','text-to-video',6,120006,'siluet-1','[]')`);
				await db.run(sql`INSERT INTO model_refusal VALUES ('poyo','flux-dev',1,7,'derived')`);
			},
			undefined,
			released,
		);
		const before = await (async () => {
			const client = await connect(join(directory, "studio.db"));
			try {
				const db = drizzle({ client });
				return await Promise.all(kept.map(async (query) => JSON.stringify(await db.all(query))));
			} finally {
				await client.close();
			}
		})();
		const upgraded = await openInstallation(directory);
		try {
			expect(await upgraded.use((db) => schemaFingerprint(db))).toBe(currentSchema);
			const after = await upgraded.use((db) =>
				Promise.all(kept.map(async (query) => JSON.stringify(await db.all(query)))),
			);
			expect(after).toEqual(before);
			expect(await upgraded.use((db) => db.all(sql`SELECT * FROM provider_inventory`))).toEqual([]);
			expect(
				await upgraded.use((db) => db.all(sql`SELECT * FROM provider_inventory_generation`)),
			).toEqual([]);
		} finally {
			await upgraded.close();
		}
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("the inventory CHECKs refuse every malformed row", async () => {
	const directory = await createOwnerDirectory();
	const installation = await openInstallation(directory);
	const refused = (statement: SQL) =>
		installation
			.use((db) => db.run(statement))
			.then(
				() => null,
				(error: unknown) => error,
			);
	const row = (
		provider: string,
		scope: string,
		outcome: string,
		models: string | null,
		generation = 1,
	) =>
		sql`INSERT INTO provider_inventory(provider,origin,scope,revision,generation,checked_at,outcome,models)
			VALUES (${provider},'https://toapis.com',${scope},1,${generation},10,${outcome},${models})`;
	try {
		for (const statement of [
			row("poyo", "image", "succeeded", "[]"),
			row("toapis", "audio", "succeeded", "[]"),
			row("toapis", "image", "listed", "[]"),
			row("toapis", "image", "succeeded", null),
			row("toapis", "image", "succeeded", "{}"),
			row("toapis", "image", "succeeded", '"a"'),
			row("toapis", "image", "succeeded", "x"),
			row("toapis", "image", "rejected", "[]"),
			row("toapis", "image", "unavailable", '["a"]'),
			row("toapis", "image", "succeeded", "[]", 0),
			sql`INSERT INTO provider_inventory_generation VALUES ('toapis','https://toapis.com','image',0)`,
			sql`INSERT INTO provider_inventory_generation VALUES ('poyo','https://toapis.com','image',1)`,
			sql`INSERT INTO provider_inventory_generation VALUES ('toapis','https://toapis.com','text',1)`,
		]) {
			// A CHECK failure, never a JSON parse error: malformed JSON such as `x` must reach the
			// COALESCE form and fail the constraint.
			const error = await refused(statement);
			expect(String((error as Error | null)?.cause)).toMatch(/CHECK constraint failed/i);
		}
		for (const statement of [
			row("toapis", "image", "succeeded", "[]"),
			row("toapis", "video", "succeeded", '["a"]'),
			sql`INSERT INTO provider_inventory_generation VALUES ('toapis','https://toapis.com','image',1)`,
		])
			expect(await refused(statement)).toBeNull();
		// One snapshot per provider, origin, scope and revision.
		expect(await refused(row("toapis", "image", "rejected", null))).toBeInstanceOf(Error);
		const rejected = sql`INSERT INTO provider_inventory(provider,origin,scope,revision,generation,checked_at,outcome,models)
			VALUES ('toapis','https://toapis.com','image',2,1,10,'rejected',NULL)`;
		expect(await refused(rejected)).toBeNull();
	} finally {
		await installation.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("the inventory migration sorts after the image contract", () => {
	expect(Object.keys(installationMigrations).sort().at(-1)).toBe(inventoryMigrationName);
	expect(inventoryMigrationName > imageContractMigrationName).toBe(true);
});
