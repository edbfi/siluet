import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { lstat, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { connect } from "@tursodatabase/database";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/tursodatabase/database";
import { createInstallation37 } from "../../../../tests/fixtures/db/installation-37";
import { migrations37 } from "../../../../tests/fixtures/db/migrations-37";
import { migrationsAs2 } from "../../../../tests/fixtures/db/migrations-as2";
import { createOwnerDirectory } from "../../../../tests/fixtures/owner-directory";
import { referencePng } from "../../../../tests/fixtures/reference-image";
import { createAutoSave } from "../services/gallery/auto-save";
import { galleryStorage } from "../services/gallery/storage";
import { createJobTracking } from "../services/jobs/tracking";
import { createOwnerAccess } from "../services/owner/access";
import { openInstallation } from "./installation";
import { mediaCleaning } from "./media-cleaning";
import { installationMigrations, migrateInstallation } from "./migrations";
import { providerStore } from "./provider-store";
import { recoverOwner } from "./recover-owner";
import { currentSchema, schemaFingerprint } from "./recovery-schema";
import { openRuntimeInstallation } from "./runtime-installation";
import { saveIntentStore } from "./save-intent";

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

test("a #37 installation upgrades to automatic Save intents and holds, then saves once with no POST", async () => {
	const directory = await createOwnerDirectory();
	const video = await readFile("tests/fixtures/video/silent.mp4");
	const now = Date.parse("2026-11-23T00:00:00Z");
	try {
		await createInstallation37(directory, async (db) => {
			const job = (key: string, state: string, business: string | null, expires: number | null) =>
				db.run(sql`INSERT INTO image_job
					(id,binding,provider,revision,quote,state,model,created_at,poll_deadline,submission_recorded_at,task_id,business_id,expires_at)
					VALUES (${key},${`${key}-binding`},${business ? "toapis" : "poyo"},1,'{}',${state},
					${business ? "seedance-2-5" : "seedream-5.5"},1,120002,2,${`${key}-task`},${business},${expires})`);
			await job("saved-image", "completed", null, null);
			await job("saved-video", "completed", "saved-business", null);
			await job("unsaved-image", "completed", null, null);
			await job("unsaved-video", "completed", "unsaved-business", null);
			await job("removing", "completed", null, null);
			await job("missing", "completed", null, null);
			await job("unsupported", "completed", null, null);
			await job("unsupported-clip", "completed", "unsupported-business", null);
			await job("expired", "completed", null, 5);
			await job("running", "running", null, null);
			await db.run(
				sql`UPDATE image_job SET gallery_reason='unsupported-image' WHERE id='unsupported'`,
			);
			await db.run(
				sql`UPDATE image_job SET pause_reason='unsupported-video-result' WHERE id='unsupported-clip'`,
			);
			await writeFile(join(directory, `gallery-${digest("saved-image")}`), referencePng, {
				mode: 0o600,
			});
			const videoPath = join(directory, `gallery-${digest("saved-video")}`);
			await writeFile(videoPath, video, { mode: 0o600 });
			const stat = await lstat(videoPath, { bigint: true });
			const identity = [stat.dev, stat.ino, stat.ctimeNs].join("/");
			await db.run(sql`INSERT INTO gallery_image
				(job_id,state,mime,width,height,size,digest,saved_at,duration,file_identity)
				VALUES ('saved-image','saved','image/png',1,1,${referencePng.length},${digest(referencePng)},3,NULL,NULL),
				('saved-video','saved','video/mp4',96,64,${video.length},${digest(video)},4,2,${identity}),
				('removing','deleting','image/png',1,1,1,'d',5,NULL,NULL),
				('missing','unavailable','image/png',1,1,1,'d',6,NULL,NULL)`);
			await db.run(sql`INSERT INTO video_save(singleton,job_id,token,pid,runtime)
				VALUES(1,'unsaved-video','interrupted-token',1,'')`);
		});

		const upgraded = await openRuntimeInstallation(directory);
		const requests: string[] = [];
		const transfers: string[] = [];
		let jobs: ReturnType<typeof createJobTracking> | undefined;
		let autoSave: ReturnType<typeof createAutoSave> | undefined;
		try {
			expect(
				await upgraded.use((db) =>
					db.all(
						sql`SELECT id, save_due, save_hold, save_attempt, save_tries FROM image_job ORDER BY id`,
					),
				),
			).toEqual(
				[
					["expired", 0, null],
					["missing", null, null],
					["removing", null, "removed"],
					["running", null, null],
					["saved-image", null, null],
					["saved-video", null, null],
					["unsaved-image", 0, null],
					["unsaved-video", 0, null],
					["unsupported", null, "unsupported"],
					["unsupported-clip", null, "unsupported"],
				].map(([job, due, hold]) => ({
					id: job,
					save_due: due,
					save_hold: hold,
					save_attempt: null,
					save_tries: 0,
				})),
			);
			expect(
				await upgraded.use((db) =>
					db.all(sql`SELECT name FROM sqlite_schema WHERE name='video_save'`),
				),
			).toEqual([]);

			// The upgraded runtime downloads each completed, unsaved job with one status read.
			const store = providerStore(upgraded);
			await store.save("poyo", "fixture-poyo", now, true, 0);
			await store.save("toapis", "fixture-toapis", now, false, 0);
			const clip = "https://93.184.216.34/clip.mp4?sig=signed-sentinel";
			const image = "https://93.184.216.34/image.png?sig=signed-sentinel";
			jobs = createJobTracking(upgraded, store, {
				now: () => now,
				random: () => 0,
				fetch: async (url, init) => {
					requests.push(`${init.method ?? "GET"} ${new URL(url).pathname}`);
					if (url.includes("/videos/generations/"))
						return Response.json({
							id: "unsaved-video-task",
							object: "generation.task",
							model: "seedance-2-5",
							client_business_id: "unsaved-business",
							status: "completed",
							progress: 100,
							result: { type: "video", data: [{ url: clip }] },
						});
					return Response.json({
						code: 200,
						data: {
							task_id: "unsaved-image-task",
							status: "finished",
							files: [{ file_type: "image", file_url: image }],
						},
					});
				},
			});
			const gallery = galleryStorage(upgraded);
			await gallery.recover();
			await saveIntentStore(upgraded).clearAbandoned();
			await jobs.resume();
			autoSave = createAutoSave(upgraded, {
				readForSave: jobs.readForSave,
				readability: store.jobReadability,
				now: () => now,
				transport: {
					resolve: async () => "93.184.216.34",
					request: async (url) => {
						transfers.push(url.pathname);
						return new Response(url.pathname.endsWith(".mp4") ? video : referencePng);
					},
				},
			});
			autoSave.start();
			await Bun.sleep(5);
			await autoSave.idle();
			expect(requests.toSorted()).toEqual([
				"GET /api/generate/status/unsaved-image-task",
				"GET /v1/videos/generations/unsaved-video-task",
			]);
			expect(transfers.toSorted()).toEqual(["/clip.mp4", "/image.png"]);
			expect((await gallery.read("unsaved-image"))?.bytes).toEqual(referencePng);
			const saved = await gallery.openVideo("unsaved-video");
			try {
				expect(await saved?.handle.readFile()).toEqual(video);
			} finally {
				await saved?.handle.close();
			}
			expect((await gallery.read("saved-image"))?.bytes).toEqual(referencePng);
			const savedVideo = await gallery.openVideo("saved-video");
			try {
				expect(await savedVideo?.handle.readFile()).toEqual(video);
			} finally {
				await savedVideo?.handle.close();
			}
			expect(await gallery.get("removing")).toBeNull();
			expect(await gallery.get("missing")).toMatchObject({ available: false });
			const summaries = await jobs.list();
			const library = Object.fromEntries(summaries.map((job) => [job.id, job.library]));
			expect(library).toEqual({
				expired: "expired",
				missing: "unavailable",
				removing: "removed",
				running: "none",
				"saved-image": "saved",
				"saved-video": "saved",
				"unsaved-image": "saved",
				"unsaved-video": "saved",
				unsupported: "unsupported",
				"unsupported-clip": "unsupported",
			});
			const rows = await upgraded.use((db) => db.all(sql`SELECT * FROM image_job`));
			expect(JSON.stringify([rows, summaries])).not.toContain("signed-sentinel");
		} finally {
			jobs?.close();
			await autoSave?.close();
			await upgraded.close();
		}
		const recovery = await openInstallation(directory, "recovery");
		try {
			expect(await recovery.hasOwner()).toBe(true);
		} finally {
			await recovery.close();
		}
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}, 30_000);

test.each([
	["R1a-era (#37 history)", migrations37],
	["AS2", migrationsAs2],
] as const)(
	"a populated %s installation reaches the local-file edit release",
	async (_label, history) => {
		const directory = await createOwnerDirectory();
		try {
			const { password } = await createInstallation37(
				directory,
				async (db) => {
					await db.run(
						sql`INSERT INTO model_access VALUES ('toapis', 'seedance-2-5', 1, 'eligible', 2)`,
					);
					await db.run(sql`INSERT INTO image_job
					(id,binding,provider,revision,quote,state,model,created_at,poll_deadline,submission_recorded_at,task_id)
					VALUES ('saved','saved-binding','poyo',1,'{}','completed','seedream-5.5',1,120002,2,'saved-task'),
					('pending','pending-binding','toapis',1,'{}','submitting','doubao-seedream-5-5',3,120003,NULL,NULL)`);
					await db.run(sql`INSERT INTO gallery_image (job_id,state,mime,width,height,size,digest,saved_at)
					VALUES ('saved','saved','image/png',1,1,${referencePng.length},${digest(referencePng)},3)`);
					await writeFile(join(directory, `gallery-${digest("saved")}`), referencePng, {
						mode: 0o600,
					});
				},
				undefined,
				history,
			);
			const upgraded = await openRuntimeInstallation(directory);
			try {
				expect(await upgraded.use((db) => schemaFingerprint(db))).toBe(currentSchema);
				expect(await mediaCleaning(upgraded).read()).toEqual({ enabled: true, revision: 0 });
				expect(
					await upgraded.use((db) =>
						db.all(
							sql`SELECT id, binding, state, file_owner, file_phase FROM image_job ORDER BY id`,
						),
					),
				).toEqual([
					{
						id: "pending",
						binding: "pending-binding",
						state: "submitting",
						file_owner: null,
						file_phase: null,
					},
					{
						id: "saved",
						binding: "saved-binding",
						state: "completed",
						file_owner: null,
						file_phase: null,
					},
				]);
				expect(await upgraded.use((db) => db.all(sql`SELECT * FROM poyo_upload_start`))).toEqual(
					[],
				);
				const access = createOwnerAccess(upgraded);
				expect((await access.signIn("creator", password)).kind).toBe("session");
				const gallery = galleryStorage(upgraded);
				await gallery.recover();
				expect((await gallery.read("saved"))?.bytes).toEqual(referencePng);
				// A URL job cannot gain a file phase without a dispatch owner.
				await expect(
					upgraded.use((db) =>
						db.run(sql`UPDATE image_job SET file_phase='claimed' WHERE id='pending'`).execute(),
					),
				).rejects.toThrow();
			} finally {
				await upgraded.close();
			}
			const recovery = await openInstallation(directory, "recovery");
			try {
				expect(await recovery.hasOwner()).toBe(true);
			} finally {
				await recovery.close();
			}
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	},
	30_000,
);
