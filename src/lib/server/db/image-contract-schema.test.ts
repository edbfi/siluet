import { expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { connect } from "@tursodatabase/database";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/tursodatabase/database";
import { createInstallation37 } from "../../../../tests/fixtures/db/installation-37";
import { createOwnerDirectory } from "../../../../tests/fixtures/owner-directory";
import { imageContractMigrationName } from "./image-contract-schema";
import { openInstallation } from "./installation";
import { installationMigrations } from "./migrations";
import { currentSchema, schemaFingerprint } from "./recovery-schema";

// Only the migrations released before this one, so a later migration cannot run early.
const released = Object.fromEntries(
	Object.entries(installationMigrations).filter(([key]) => key < imageContractMigrationName),
);
const snapshot = [
	sql`SELECT * FROM image_job ORDER BY id`,
	sql`SELECT * FROM image_batch ORDER BY id`,
	sql`SELECT * FROM gallery_image ORDER BY job_id`,
];

test("the upgrade keeps every job, batch and Gallery row, and adds the contract and refusal record", async () => {
	const directory = await createOwnerDirectory();
	try {
		await createInstallation37(
			directory,
			async (db) => {
				await db.run(sql`INSERT INTO image_batch(id,binding,provider,revision,quote,accepted_unknown,model,operation,
					terms_digest,disclosure_version,request_count,retry_limit,created_at,deadline)
					VALUES ('batch','batch-binding','poyo',1,'{}',0,'seedream-5.5','generate','terms','batch-terms-v1',2,1,5,120005)`);
				await db.run(sql`INSERT INTO image_job
					(id,binding,provider,revision,quote,state,model,operation,created_at,poll_deadline,task_id,submission_recorded_at)
					VALUES ('saved','saved-binding','poyo',1,'{}','completed','z-image','text-to-image',1,120003,'task-1',3),
					('rejected','rejected-binding','toapis',2,'{}','rejected','doubao-seedream-5-5','text-to-image',2,120002,NULL,NULL)`);
				await db.run(sql`INSERT INTO image_job
					(id,binding,provider,revision,quote,state,model,created_at,poll_deadline,batch_id,slot,attempt)
					VALUES ('slot','slot-binding','poyo',1,'{}','submitting','seedream-5.5',5,120005,'batch',1,1)`);
				await db.run(sql`INSERT INTO gallery_image
					(job_id,state,mime,width,height,size,digest,saved_at,duration,file_identity)
					VALUES ('saved','saved','image/webp',3,2,60,'webp-digest',8,NULL,NULL)`);
			},
			undefined,
			released,
		);
		const before = await (async () => {
			const client = await connect(join(directory, "studio.db"));
			try {
				const db = drizzle({ client });
				return await Promise.all(
					snapshot.map(async (query) => JSON.stringify(await db.all(query))),
				);
			} finally {
				await client.close();
			}
		})();

		const upgraded = await openInstallation(directory);
		try {
			expect(await upgraded.use((db) => schemaFingerprint(db))).toBe(currentSchema);
			const after = await upgraded.use((db) =>
				Promise.all(snapshot.map((query) => db.all<Record<string, unknown>>(query))),
			);
			// Each job keeps every value and gains a NULL contract: the shipped adapter paths.
			const jobs = after[0].map(({ contract, ...job }) => {
				expect(contract).toBeNull();
				return job;
			});
			expect(JSON.stringify(jobs)).toBe(before[0]);
			expect(JSON.stringify(after[1])).toBe(before[1]);
			expect(JSON.stringify(after[2])).toBe(before[2]);
			expect(await upgraded.use((db) => db.all(sql`SELECT * FROM model_refusal`))).toEqual([]);
			// One refusal per provider, model and credential revision.
			await upgraded.use((db) =>
				db.run(sql`INSERT INTO model_refusal(provider,model,credential_revision,refused_at,job_id)
					VALUES ('poyo','flux-dev',1,10,'saved')`),
			);
			const repeated = await upgraded
				.use((db) =>
					db.run(sql`INSERT INTO model_refusal(provider,model,credential_revision,refused_at,job_id)
						VALUES ('poyo','flux-dev',1,11,'slot')`),
				)
				.then(
					() => null,
					(error: unknown) => error,
				);
			expect(repeated).toBeInstanceOf(Error);
		} finally {
			await upgraded.close();
		}
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("the contract migration sorts after every released one and before G9's inventory", () => {
	expect(Object.keys(installationMigrations).sort().at(-1)).toBe(imageContractMigrationName);
	expect(imageContractMigrationName > "20261128120000_gallery_webp").toBe(true);
	expect(imageContractMigrationName < "20261130000000_toapis_inventory").toBe(true);
});
