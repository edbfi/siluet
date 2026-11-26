import { expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { connect } from "@tursodatabase/database";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/tursodatabase/database";
import { createInstallation37 } from "../../../../tests/fixtures/db/installation-37";
import { createOwnerDirectory } from "../../../../tests/fixtures/owner-directory";
import { openInstallation } from "./installation";
import { installationMigrations } from "./migrations";
import { currentSchema, schemaFingerprint } from "./recovery-schema";

const name = "20261128120000_gallery_webp";
// Only the migrations released before this one, so a later migration cannot run early.
const released = Object.fromEntries(
	Object.entries(installationMigrations).filter(([key]) => key < name),
);
const gallery = sql`SELECT * FROM gallery_image ORDER BY job_id`;
const tableSql = sql`SELECT sql FROM sqlite_schema WHERE type='table' AND name='gallery_image'`;

async function refusedByCheck(write: Promise<unknown>) {
	const error = await write.then(
		() => null,
		(caught: unknown) => caught,
	);
	expect(error).toBeInstanceOf(Error);
	expect(String((error as Error).cause ?? error)).toMatch(/CHECK/i);
}

test("the upgrade admits still WebP and keeps every Gallery row and video constraint", async () => {
	const directory = await createOwnerDirectory();
	try {
		await createInstallation37(
			directory,
			async (db) => {
				await db.run(sql`INSERT INTO gallery_image
					(job_id,state,mime,width,height,size,digest,saved_at,duration,file_identity)
					VALUES ('png','saved','image/png',1,1,10,'png-digest',3,NULL,NULL),
					('jpeg','unavailable','image/jpeg',4000,4000,20,'jpeg-digest',4,NULL,NULL),
					('removing','deleting','image/png',2,2,30,'removing-digest',5,NULL,NULL),
					('clip','saved','video/mp4',832,480,40,'clip-digest',6,15.041666666666666,'1/2/3'),
					('long','unavailable','video/mp4',96,64,50,'long-digest',7,61,'4/5/6')`);
			},
			undefined,
			released,
		);
		const before = await (async () => {
			const client = await connect(join(directory, "studio.db"));
			try {
				const db = drizzle({ client });
				return {
					rows: JSON.stringify(await db.all(gallery)),
					table: (await db.get<{ sql: string }>(tableSql))?.sql ?? "",
				};
			} finally {
				await client.close();
			}
		})();

		const upgraded = await openInstallation(directory);
		try {
			expect(await upgraded.use((db) => schemaFingerprint(db))).toBe(currentSchema);
			expect(JSON.stringify(await upgraded.use((db) => db.all(gallery)))).toBe(before.rows);
			// The rebuilt table differs from the released one only by the admitted type.
			const table = (await upgraded.use((db) => db.get<{ sql: string }>(tableSql)))?.sql;
			const admitted = "mime IN ('image/png','image/jpeg','video/mp4')";
			expect(before.table).toContain(admitted);
			expect(table).toBe(
				before.table.replace(
					admitted,
					"mime IN ('image/png','image/jpeg','image/webp','video/mp4')",
				),
			);

			const insert = (id: string, mime: string, duration: number | null, identity: string | null) =>
				upgraded.use((db) =>
					db.run(sql`INSERT INTO gallery_image
						(job_id,state,mime,width,height,size,digest,saved_at,duration,file_identity)
						VALUES (${id},'saved',${mime},3,2,60,'d',8,${duration},${identity})`),
				);
			await insert("webp", "image/webp", null, null);
			expect(
				await upgraded.use((db) => db.get(sql`SELECT mime FROM gallery_image WHERE job_id='webp'`)),
			).toEqual({ mime: "image/webp" });
			for (const mime of ["image/gif", "image/avif", "image/WEBP", "video/webm"])
				await refusedByCheck(insert(`other-${mime}`, mime, null, null));
			// Video keeps its 61-second ceiling, a positive duration and a file identity.
			await insert("at-ceiling", "video/mp4", 61, "7/8/9");
			await refusedByCheck(insert("over-ceiling", "video/mp4", 61.01, "7/8/9"));
			await refusedByCheck(insert("no-duration", "video/mp4", null, "7/8/9"));
			await refusedByCheck(insert("zero-duration", "video/mp4", 0, "7/8/9"));
			await refusedByCheck(insert("no-identity", "video/mp4", 5, null));
			await refusedByCheck(
				upgraded.use((db) =>
					db.run(sql`INSERT INTO gallery_image (job_id,state,mime,width,height,size,digest,saved_at)
						VALUES ('bad-state','held','image/webp',1,1,1,'d',9)`),
				),
			);
		} finally {
			await upgraded.close();
		}
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}, 30_000);
