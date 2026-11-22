import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { lstat, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { connect } from "@tursodatabase/database";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/tursodatabase/database";
import { createOwnerDirectory } from "../../../../tests/fixtures/owner-directory";
import { referencePng } from "../../../../tests/fixtures/reference-image";
import { galleryStorage } from "../services/gallery/storage";
import { createOwnerAccess } from "../services/owner/access";
import { openInstallation } from "./installation";
import { installationMigrations, migrateInstallation } from "./migrations";
import { recoverOwner } from "./recover-owner";

const videoReleaseHistory = [
	"20261121000000_owner_access",
	"20261121191912_provider_credentials",
	"20261121223139_first_saved_image",
	"20261122000549_seedream_reference_failure",
	"20261122030400_image_job_operation",
	"20261122120000_live_image_batches",
	"20261122121000_first_saved_video",
] as const;

const digest = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");

test("a saved-video installation upgrades with its owner, Gallery bytes and recovery access intact", async () => {
	const directory = await createOwnerDirectory();
	const password = crypto.randomUUID();
	const id = crypto.randomUUID();
	const video = await readFile("tests/fixtures/video/silent.mp4");
	try {
		await writeFile(join(directory, "installation.id"), id, { mode: 0o600 });
		const client = await connect(join(directory, "studio.db"));
		try {
			const db = drizzle({ client });
			await migrateInstallation(
				db,
				true,
				Object.fromEntries(videoReleaseHistory.map((name) => [name, installationMigrations[name]])),
			);
			const hash = await Bun.password.hash(password, { algorithm: "argon2id" });
			await db.run(sql`INSERT INTO installation VALUES (1, ${id}, 1)`);
			await db.run(sql`INSERT INTO owner VALUES (1, 'creator', ${hash}, 10)`);
			await db.run(
				sql`INSERT INTO model_access VALUES ('toapis', 'seedance-2-5', 1, 'eligible', 2)`,
			);
			await db.run(sql`INSERT INTO image_job
				(id,binding,provider,revision,quote,state,model,created_at,poll_deadline,submission_recorded_at,task_id,business_id)
				VALUES ('image','image-binding','poyo',1,'{}','completed','seedream-5.5',1,120002,2,'image-task',NULL),
				('video','video-binding','toapis',1,'{}','completed','seedance-2-5',1,120002,2,'video-task','video-business')`);
			await writeFile(join(directory, `gallery-${digest("image")}`), referencePng, { mode: 0o600 });
			const videoPath = join(directory, `gallery-${digest("video")}`);
			await writeFile(videoPath, video, { mode: 0o600 });
			const stat = await lstat(videoPath, { bigint: true });
			const identity = [stat.dev, stat.ino, stat.ctimeNs].join("/");
			await db.run(sql`INSERT INTO gallery_image
				(job_id,state,mime,width,height,size,digest,saved_at,duration,file_identity)
				VALUES ('image','saved','image/png',1,1,${referencePng.length},${digest(referencePng)},3,NULL,NULL),
				('video','saved','video/mp4',96,64,${video.length},${digest(video)},4,2,${identity})`);
		} finally {
			await client.close();
		}

		const upgraded = await openInstallation(directory);
		try {
			expect(upgraded.id).toBe(id);
			const access = createOwnerAccess(upgraded);
			const signIn = await access.signIn("creator", password);
			expect(signIn.kind).toBe("session");
			expect(await access.session(signIn.token)).toBe("creator");
			expect((await access.security.snapshot()).state.enabled).toBe(0);
			expect(
				await upgraded.use((db) =>
					db.all(sql`SELECT task_id, business_id FROM image_job ORDER BY id`),
				),
			).toEqual([
				{ task_id: "image-task", business_id: null },
				{ task_id: "video-task", business_id: "video-business" },
			]);
		} finally {
			await upgraded.close();
		}
		const recovery = await openInstallation(directory, "recovery");
		try {
			expect(await recovery.hasOwner()).toBe(true);
			const hash = await Bun.password.hash(crypto.randomUUID(), { algorithm: "argon2id" });
			await recoverOwner(recovery, hash, () => {});
		} finally {
			await recovery.close();
		}
		const reopened = await openInstallation(directory);
		try {
			expect(
				await reopened.use((db) =>
					db.get(sql`SELECT revision, state, checked_at FROM model_access
				WHERE provider='toapis' AND model='seedance-2-5'`),
				),
			).toEqual({
				revision: 1,
				state: "eligible",
				checked_at: 2,
			});
			const gallery = galleryStorage(reopened);
			await gallery.recover();
			expect((await gallery.read("image"))?.bytes).toEqual(referencePng);
			const savedVideo = await gallery.openVideo("video");
			if (!savedVideo) throw new Error("Expected the saved video to reopen.");
			try {
				expect(await savedVideo.handle.readFile()).toEqual(video);
			} finally {
				await savedVideo.handle.close();
			}
		} finally {
			await reopened.close();
		}
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}, 30_000);
