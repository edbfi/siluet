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
import { migrationsR1b } from "../../../../tests/fixtures/db/migrations-r1b";
import { createOwnerDirectory } from "../../../../tests/fixtures/owner-directory";
import { referencePng } from "../../../../tests/fixtures/reference-image";
import { box, h264Aac, retimeClip } from "../../../../tests/fixtures/video/mp4-boxes";
import { h3MaxShape, seedanceShape } from "../../../../tests/fixtures/video/real-clips";
import { createAutoSave } from "../services/gallery/auto-save";
import { galleryStorage } from "../services/gallery/storage";
import { createJobTracking } from "../services/jobs/tracking";
import { createOwnerAccess } from "../services/owner/access";
import { fileAttemptStore } from "./file-attempt";
import { filePhases } from "./file-edit-schema";
import { openInstallation } from "./installation";
import { mediaCleaning } from "./media-cleaning";
import { installationMigrations, migrateInstallation } from "./migrations";
import { orderedFileMigration } from "./ordered-file-schema";
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

// One R1b job per released file phase, plus the two cooldown rows R1b stored as `retry_at`.
const r1bJobs = [
	["claimed", "claimed", "submitting", 1, null],
	["uploading", "uploading", "submitting", 1, null],
	["uploaded", "uploaded", "submitting", 1, null],
	["editing", "editing", "submitting", 1, null],
	["unsent", "unsent", "rejected", 0, null],
	["unsent-cooldown", "unsent", "rejected", 0, 9_000],
	["upload-unknown", "upload-unknown", "unknown", 1, null],
	["stored", "stored", "rejected", 0, null],
	["stored-cooldown", "stored", "rejected", 1, 9_000],
	["upload-rejected", "upload-rejected", "rejected", 0, null],
	["edit-unknown", "edit-unknown", "unknown", 1, null],
	["edit-recorded", "edit-recorded", "waiting", 0, null],
] as const;

test("a populated R1b installation gives every file job one slot and recovers each phase", async () => {
	const directory = await createOwnerDirectory();
	try {
		await createInstallation37(
			directory,
			async (db) => {
				for (const [id, phase, state, wallet, retryAt] of r1bJobs)
					await db.run(sql`INSERT INTO image_job
						(id,binding,provider,revision,quote,state,model,created_at,poll_deadline,file_owner,file_phase,wallet_open,retry_at,task_id,submission_recorded_at)
						VALUES (${id},${`${id}-binding`},'poyo',1,'{}',${state},'seedream-5.5',1,
						${phase === "edit-recorded" ? 120_003 : 120_001},'r1b',${phase},${wallet},${retryAt},
						${phase === "edit-recorded" ? "task" : null},${phase === "edit-recorded" ? 3 : null})`);
				await db.run(sql`INSERT INTO image_job
					(id,binding,provider,revision,quote,state,model,created_at,poll_deadline)
					VALUES ('url','url-binding','toapis',1,'{}','completed','doubao-seedream-5-5',1,120001)`);
			},
			undefined,
			migrationsR1b,
		);
		const upgraded = await openRuntimeInstallation(directory);
		try {
			expect(await upgraded.use((db) => schemaFingerprint(db))).toBe(currentSchema);
			const slots = await upgraded.use((db) =>
				db.all<{ id: string; position: number; outcome: string }>(
					sql`SELECT job_id AS id, position, outcome FROM file_slot ORDER BY job_id`,
				),
			);
			expect(Object.fromEntries(slots.map((s) => [s.id, [s.position, s.outcome]]))).toEqual({
				claimed: [1, "unsent"],
				editing: [1, "stored"],
				"edit-recorded": [1, "stored"],
				"edit-unknown": [1, "stored"],
				stored: [1, "stored"],
				"stored-cooldown": [1, "stored"],
				unsent: [1, "unsent"],
				"unsent-cooldown": [1, "unsent"],
				uploaded: [1, "stored"],
				"upload-rejected": [1, "rejected"],
				"upload-unknown": [1, "unknown"],
				uploading: [1, "uploading"],
			});
			const stops = await upgraded.use((db) =>
				db.all(
					sql`SELECT id, file_references, file_stop, file_stop_slot, file_other_slot FROM image_job ORDER BY id`,
				),
			);
			for (const row of stops as Record<string, unknown>[]) {
				const cooldown = String(row.id).endsWith("-cooldown");
				expect(row).toEqual({
					id: row.id,
					file_references: row.id === "url" ? null : 1,
					file_stop: cooldown ? "cooldown" : null,
					// R1b's pre-upload cooldown stopped before slot 1; its pre-edit cooldown has no slot.
					file_stop_slot: row.id === "unsent-cooldown" ? 1 : null,
					file_other_slot: null,
				});
			}
			await fileAttemptStore(upgraded, "next").recover(10);
			const recovered = await upgraded.use((db) =>
				db.all<{
					id: string;
					file_phase: string;
					state: string;
					wallet_open: number;
					file_stop: string | null;
				}>(
					sql`SELECT id, file_phase, state, wallet_open, file_stop FROM image_job
						WHERE id IN ('claimed','uploading','uploaded','editing') ORDER BY id`,
				),
			);
			// R1b recovers `uploaded` as stored, rejected and wallet closed; R2 keeps that outcome.
			expect(recovered).toEqual([
				{
					id: "claimed",
					file_phase: "unsent",
					state: "rejected",
					wallet_open: 0,
					file_stop: "interrupted",
				},
				{
					id: "editing",
					file_phase: "edit-unknown",
					state: "unknown",
					wallet_open: 1,
					file_stop: null,
				},
				{
					id: "uploaded",
					file_phase: "stored",
					state: "rejected",
					wallet_open: 0,
					file_stop: "interrupted",
				},
				{
					id: "uploading",
					file_phase: "upload-unknown",
					state: "unknown",
					wallet_open: 1,
					file_stop: null,
				},
			]);
			expect(
				await upgraded.use((db) =>
					db.get(sql`SELECT outcome FROM file_slot WHERE job_id='uploading'`),
				),
			).toEqual({ outcome: "unknown" });
		} finally {
			await upgraded.close();
		}
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}, 30_000);

test("the R2 migration names every released file phase, so none falls through", () => {
	const statements = orderedFileMigration.split("--> statement-breakpoint");
	const backfill = statements.find((statement) => statement.includes("INSERT INTO file_slot"));
	for (const phase of filePhases) expect(backfill).toContain(`WHEN '${phase}' THEN`);
	expect(backfill).not.toContain("ELSE");
});

// Every migration released before the real-clip version; their digests are pinned in
// released-migrations.ts.
const realClipHistory = Object.fromEntries(
	Object.entries(installationMigrations).filter(
		([name]) => name <= "20261124120000_seedream_ordered_files",
	),
);

test("refused MP4 clips are re-armed once and save with one status read and no POST", async () => {
	const directory = await createOwnerDirectory();
	const start = Date.parse("2026-11-25T00:00:00Z");
	let now = start;
	try {
		await createInstallation37(
			directory,
			async (db) => {
				const job = (
					id: string,
					video: "poyo" | "toapis" | null,
					hold: string,
					pause: string | null = null,
					expires: number | null = null,
				) =>
					db.run(sql`INSERT INTO image_job
						(id,binding,provider,revision,quote,state,model,created_at,poll_deadline,submission_recorded_at,
						task_id,business_id,video_terms,save_hold,pause_reason,expires_at)
						VALUES (${id},${`${id}-binding`},${video === "toapis" ? "toapis" : "poyo"},1,'{}','completed',
						${video === "toapis" ? "seedance-2-5" : video === "poyo" ? "h3-max" : "seedream-5.5"},
						1,120002,2,${`${id}-task`},${video === "toapis" ? `${id}-business` : null},
						${video === "poyo" ? "[]" : null},${hold},${pause},${expires})`);
				await job("poyo-held", "poyo", "unsupported");
				await job("toapis-held", "toapis", "unsupported");
				await job("still-bad", "toapis", "unsupported");
				await job("provider-flagged", "toapis", "unsupported", "unsupported-video-result");
				// Flagged by the provider, then a later read replaced the note (recordStatus).
				await job("flag-overwritten", "toapis", "unsupported", "unknown-status");
				await job("expired-held", "toapis", "unsupported", null, 5);
				await job("webm", "toapis", "webm");
				await job("removed", "poyo", "removed");
				await job("failed", "toapis", "failed");
				await job("image-unsupported", null, "unsupported");
				await job("has-item", "toapis", "unsupported");
				await db.run(sql`INSERT INTO gallery_image (job_id,state,mime,width,height,size,digest,saved_at)
					VALUES ('has-item','unavailable','image/png',1,1,1,'d',3)`);
			},
			undefined,
			realClipHistory,
		);

		const served = {
			"/h3.mp4": Buffer.from(h3MaxShape()),
			"/seedance.mp4": Buffer.from(seedanceShape()),
			"/junk.mp4": Buffer.concat([h264Aac(), box("junk")]),
		} as Record<string, Buffer<ArrayBuffer>>;
		const clip = (name: string) => `https://93.184.216.34${name}?sig=signed-sentinel`;
		const toapisResult: Record<string, unknown> = {
			"toapis-held": { type: "video", data: [{ url: clip("/seedance.mp4") }] },
			"still-bad": { type: "video", data: [{ url: clip("/junk.mp4") }] },
			"flag-overwritten": { type: "image", data: [{ url: clip("/image.png") }] },
		};
		const requests: string[] = [];
		const transfers: string[] = [];
		type Tracking = ReturnType<typeof createJobTracking>;
		type Runtime = Awaited<ReturnType<typeof openRuntimeInstallation>>;
		/** Open the runtime, let automatic Save finish, then `work` before closing. */
		const run = async (work: (jobs: Tracking, installation: Runtime) => Promise<void>) => {
			const installation = await openRuntimeInstallation(directory);
			const store = providerStore(installation);
			let jobs: Tracking | undefined;
			let autoSave: ReturnType<typeof createAutoSave> | undefined;
			try {
				jobs = createJobTracking(installation, store, {
					now: () => now,
					random: () => 0,
					fetch: async (url, init) => {
						const path = new URL(url).pathname;
						requests.push(`${init.method ?? "GET"} ${path}`);
						const id =
							path
								.split("/")
								.at(-1)
								?.replace(/-task$/, "") ?? "";
						if (path.startsWith("/v1/videos/generations/"))
							return Response.json({
								id: `${id}-task`,
								object: "generation.task",
								model: "seedance-2-5",
								client_business_id: `${id}-business`,
								status: "completed",
								progress: 100,
								result: toapisResult[id],
							});
						return Response.json({
							code: 200,
							data: {
								task_id: `${id}-task`,
								status: "finished",
								files: [{ file_type: "video", file_url: clip("/h3.mp4") }],
							},
						});
					},
				});
				await galleryStorage(installation).recover();
				await saveIntentStore(installation).clearAbandoned();
				await jobs.resume();
				autoSave = createAutoSave(installation, {
					readForSave: jobs.readForSave,
					readability: store.jobReadability,
					now: () => now,
					transport: {
						resolve: async () => "93.184.216.34",
						request: async (url) => {
							transfers.push(url.pathname);
							return new Response(served[url.pathname]);
						},
					},
				});
				autoSave.start();
				await Bun.sleep(5);
				await autoSave.idle();
				await work(jobs, installation);
			} finally {
				jobs?.close();
				await autoSave?.close();
				await installation.close();
			}
		};
		const library = async (jobs: Tracking) =>
			Object.fromEntries((await jobs.list()).map((job) => [job.id, job.library]));

		// The upgrade alone re-arms the five held video rows and leaves every other hold.
		const upgraded = await openRuntimeInstallation(directory);
		try {
			expect(await upgraded.use((db) => schemaFingerprint(db))).toBe(currentSchema);
			const rows = await upgraded.use((db) =>
				db.all<{ id: string; save_due: number | null; save_hold: string | null }>(
					sql`SELECT id, save_due, save_hold FROM image_job ORDER BY id`,
				),
			);
			expect(
				Object.fromEntries(rows.map((row) => [row.id, [row.save_due, row.save_hold]])),
			).toEqual({
				"expired-held": [0, null],
				failed: [null, "failed"],
				"flag-overwritten": [0, null],
				"has-item": [null, "unsupported"],
				"image-unsupported": [null, "unsupported"],
				"poyo-held": [0, null],
				"provider-flagged": [null, "unsupported"],
				removed: [null, "removed"],
				"still-bad": [0, null],
				"toapis-held": [0, null],
				webm: [null, "webm"],
			});
			const store = providerStore(upgraded);
			await store.save("poyo", "fixture-poyo", start, true, 0);
			await store.save("toapis", "fixture-toapis", start, false, 0);
		} finally {
			await upgraded.close();
		}

		await run(async (jobs, installation) => {
			// One status read per re-armed, readable clip and no generation request.
			expect(requests.toSorted()).toEqual([
				"GET /api/generate/status/poyo-held-task",
				"GET /v1/videos/generations/still-bad-task",
				"GET /v1/videos/generations/toapis-held-task",
			]);
			expect(transfers.toSorted()).toEqual(["/h3.mp4", "/junk.mp4", "/seedance.mp4"]);
			expect(await library(jobs)).toEqual({
				"expired-held": "expired",
				failed: "failed",
				"flag-overwritten": "paused",
				"has-item": "unavailable",
				"image-unsupported": "unsupported",
				"poyo-held": "saved",
				"provider-flagged": "unsupported",
				removed: "removed",
				"still-bad": "unsupported",
				"toapis-held": "saved",
				webm: "webm",
			});
			const gallery = galleryStorage(installation);
			for (const [id, path] of [
				["poyo-held", "/h3.mp4"],
				["toapis-held", "/seedance.mp4"],
			] as const) {
				const saved = await gallery.openVideo(id);
				try {
					expect(await saved?.handle.readFile()).toEqual(served[path]);
				} finally {
					await saved?.handle.close();
				}
			}
			// Past the provider's read spacing, Refresh reads the overwritten row once; the
			// provider still reports no video.
			now = start + 60_000;
			await jobs.refresh("flag-overwritten");
			expect((await library(jobs))["flag-overwritten"]).toBe("unsupported");
			const rows = await installation.use((db) => db.all(sql`SELECT * FROM image_job`));
			expect(JSON.stringify(rows)).not.toContain("signed-sentinel");
		});
		expect(requests).toHaveLength(4);
		expect(requests).toContain("GET /v1/videos/generations/flag-overwritten-task");

		// A restart reads and downloads nothing more.
		await run(async (jobs) => {
			expect((await library(jobs))["toapis-held"]).toBe("saved");
		});
		expect(requests).toHaveLength(4);
		expect(transfers).toHaveLength(3);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}, 30_000);

/** A write the database refuses with a CHECK constraint (Drizzle wraps the driver error). */
async function refusedByCheck(write: Promise<unknown>) {
	const error = await write.then(
		() => null,
		(caught: unknown) => caught,
	);
	expect(error).toBeInstanceOf(Error);
	expect(String((error as Error).cause ?? error)).toMatch(/CHECK/i);
}

// Every migration released before per-mode Save limits, through the real-clip re-arm.
const saveLimitHistory = Object.fromEntries(
	Object.entries(installationMigrations).filter(
		([name]) => name <= "20261125120000_video_profile_rearm",
	),
);

test("jobs queued before per-mode limits adopt their mode's limit and Gallery rows stay byte-identical", async () => {
	const directory = await createOwnerDirectory();
	try {
		await createInstallation37(
			directory,
			async (db) => {
				const job = (
					id: string,
					provider: "poyo" | "toapis",
					model: string,
					operation: string | null,
					kind: "seedance" | "poyo-video" | "image",
				) =>
					db.run(sql`INSERT INTO image_job
						(id,binding,provider,revision,quote,state,model,operation,created_at,poll_deadline,
						submission_recorded_at,task_id,business_id,video_terms)
						VALUES (${id},${`${id}-binding`},${provider},1,'{}','completed',${model},${operation},
						1,120002,2,${`${id}-task`},${kind === "seedance" ? `${id}-business` : null},
						${kind === "poyo-video" ? "[]" : null})`);
				await job("text", "toapis", "seedance-2-5", "text-to-video", "seedance");
				await job("animate", "toapis", "seedance-2-5", "first-frame-to-video", "seedance");
				await job(
					"interpolate",
					"toapis",
					"seedance-2-5",
					"first-and-last-frame-to-video",
					"seedance",
				);
				await job("h3", "poyo", "h3-max", "text-to-video", "poyo-video");
				await job("edit", "toapis", "seedance-2-5", "video-edit", "seedance");
				await job("poyo-unknown", "poyo", "h3-max-turbo", "text-to-video", "poyo-video");
				await job("seedream", "toapis", "doubao-seedream-5-5", "text-to-image", "image");
				await job("z-image", "poyo", "z-image", "text-to-image", "image");
				await db.run(sql`INSERT INTO gallery_image
					(job_id,state,mime,width,height,size,digest,saved_at,duration,file_identity)
					VALUES ('seedream','saved','image/png',1,1,10,'image-digest',3,NULL,NULL),
					('text','saved','video/mp4',96,64,20,'video-digest',4,12,'1/2/3'),
					('h3','unavailable','video/mp4',832,480,30,'h3-digest',5,5.166666666666667,'4/5/6')`);
			},
			undefined,
			saveLimitHistory,
		);
		const gallery = sql`SELECT * FROM gallery_image ORDER BY job_id`;
		const before = await (async () => {
			const client = await connect(join(directory, "studio.db"));
			try {
				return JSON.stringify(await drizzle({ client }).all(gallery));
			} finally {
				await client.close();
			}
		})();

		const upgraded = await openInstallation(directory);
		try {
			expect(await upgraded.use((db) => schemaFingerprint(db))).toBe(currentSchema);
			const limits = await upgraded.use((db) =>
				db.all<{ id: string; save_seconds: number | null }>(
					sql`SELECT id, save_seconds FROM image_job ORDER BY id`,
				),
			);
			expect(Object.fromEntries(limits.map((row) => [row.id, row.save_seconds]))).toEqual({
				animate: 30,
				edit: null,
				h3: 15,
				interpolate: 30,
				"poyo-unknown": null,
				seedream: null,
				text: 30,
				"z-image": null,
			});
			expect(JSON.stringify(await upgraded.use((db) => db.all(gallery)))).toBe(before);

			// A limit is a positive integer on a video job only; text that SQLite cannot read as an
			// integer is refused, and integer text is stored as the integer.
			const limit = (id: string, value: unknown) =>
				upgraded.use((db) =>
					db.run(sql`UPDATE image_job SET save_seconds=${value} WHERE id=${id}`),
				);
			for (const value of [0, -1, 1.5, "30s"]) await refusedByCheck(limit("edit", value));
			await refusedByCheck(limit("seedream", 30));
			await limit("edit", "30");
			expect(
				await upgraded.use((db) =>
					db.get(
						sql`SELECT save_seconds, typeof(save_seconds) AS type FROM image_job WHERE id='edit'`,
					),
				),
			).toEqual({ save_seconds: 30, type: "integer" });

			// Gallery stores up to 61 seconds: the 60-second ceiling plus the allowance.
			const clip = (id: string, duration: number) =>
				upgraded.use((db) =>
					db.run(sql`INSERT INTO gallery_image
						(job_id,state,mime,width,height,size,digest,saved_at,duration,file_identity)
						VALUES (${id},'saved','video/mp4',96,64,1,'d',6,${duration},'7/8/9')`),
				);
			await clip("animate", 61);
			await refusedByCheck(clip("interpolate", 61.01));
		} finally {
			await upgraded.close();
		}
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}, 30_000);

type HeldRow = {
	id: string;
	mode: "seedance" | "h3" | "unknown" | "image";
	hold: string;
	pause?: string | null;
	expires?: number | null;
};
/** Insert completed jobs as Queue claimed them, each with a Save hold and no Gallery item. */
async function insertHeld(db: ReturnType<typeof drizzle>, rows: HeldRow[]) {
	const key = {
		seedance: ["toapis", "seedance-2-5", "text-to-video"],
		h3: ["poyo", "h3-max", "text-to-video"],
		unknown: ["toapis", "seedance-2-5", "video-edit"],
		image: ["poyo", "seedream-5.5", "text-to-image"],
	} as const;
	for (const { id, mode, hold, pause = null, expires = null } of rows) {
		const [provider, model, operation] = key[mode];
		await db.run(sql`INSERT INTO image_job
			(id,binding,provider,revision,quote,state,model,operation,created_at,poll_deadline,submission_recorded_at,
			task_id,business_id,video_terms,save_hold,pause_reason,expires_at)
			VALUES (${id},${`${id}-binding`},${provider},1,'{}','completed',${model},${operation},1,120002,2,
			${`${id}-task`},${provider === "toapis" && mode !== "image" ? `${id}-business` : null},
			${provider === "poyo" && mode !== "image" ? "[]" : null},${hold},${pause},${expires})`);
	}
}

/**
 * Open the upgraded installation with both keys saved, then run automatic Save against fixture
 * providers: every status read reports completion with `/<id>.mp4`, or `results[id]` for ToAPIs.
 */
function upgradeHarness(
	directory: string,
	clips: Record<string, Buffer>,
	results: Record<string, unknown> = {},
) {
	const start = Date.parse("2026-11-26T00:00:00Z");
	const state = { now: start, requests: [] as string[], transfers: [] as string[] };
	const clip = (id: string) => `https://93.184.216.34/${id}.mp4?sig=signed-sentinel`;
	type Tracking = ReturnType<typeof createJobTracking>;
	type Runtime = Awaited<ReturnType<typeof openRuntimeInstallation>>;
	async function saveKeys() {
		const upgraded = await openRuntimeInstallation(directory);
		try {
			const store = providerStore(upgraded);
			await store.save("poyo", "fixture-poyo", start, true, 0);
			await store.save("toapis", "fixture-toapis", start, false, 0);
		} finally {
			await upgraded.close();
		}
	}
	async function run(
		work: (jobs: Tracking, installation: Runtime) => Promise<void> = async () => {},
	) {
		const installation = await openRuntimeInstallation(directory);
		const store = providerStore(installation);
		let jobs: Tracking | undefined;
		let autoSave: ReturnType<typeof createAutoSave> | undefined;
		try {
			jobs = createJobTracking(installation, store, {
				now: () => state.now,
				random: () => 0,
				fetch: async (url, init) => {
					const path = new URL(url).pathname;
					state.requests.push(`${init.method ?? "GET"} ${path}`);
					const id =
						path
							.split("/")
							.at(-1)
							?.replace(/-task$/, "") ?? "";
					if (path.startsWith("/v1/videos/generations/"))
						return Response.json({
							id: `${id}-task`,
							object: "generation.task",
							model: "seedance-2-5",
							client_business_id: `${id}-business`,
							status: "completed",
							progress: 100,
							result: results[id] ?? { type: "video", data: [{ url: clip(id) }] },
						});
					return Response.json({
						code: 200,
						data: {
							task_id: `${id}-task`,
							status: "finished",
							files: [{ file_type: "video", file_url: clip(id) }],
						},
					});
				},
			});
			await galleryStorage(installation).recover();
			await saveIntentStore(installation).clearAbandoned();
			await jobs.resume();
			autoSave = createAutoSave(installation, {
				readForSave: jobs.readForSave,
				readability: store.jobReadability,
				now: () => state.now,
				transport: {
					resolve: async () => "93.184.216.34",
					request: async (url) => {
						state.transfers.push(url.pathname);
						return new Response(Buffer.from(clips[url.pathname.slice(1, -4)] ?? box("junk")));
					},
				},
			});
			autoSave.start();
			await Bun.sleep(5);
			await autoSave.idle();
			await work(jobs, installation);
		} finally {
			jobs?.close();
			await autoSave?.close();
			await installation.close();
		}
	}
	const library = async (jobs: Tracking) =>
		Object.fromEntries((await jobs.list()).map((job) => [job.id, job.library]));
	return { state, start, saveKeys, run, library };
}

test("clips held for length re-arm once under their mode's limit and save with one status read and no POST", async () => {
	const directory = await createOwnerDirectory();
	try {
		await createInstallation37(
			directory,
			async (db) => {
				await insertHeld(db, [
					{ id: "h3-long", mode: "h3", hold: "unsupported" },
					{ id: "seedance-long", mode: "seedance", hold: "unsupported" },
					{ id: "still-long", mode: "seedance", hold: "unsupported" },
					{ id: "legacy-long", mode: "unknown", hold: "unsupported" },
					{
						id: "provider-flagged",
						mode: "seedance",
						hold: "unsupported",
						pause: "unsupported-video-result",
					},
					// Flagged by the provider, then a later read replaced the note (recordStatus).
					{
						id: "flag-overwritten",
						mode: "seedance",
						hold: "unsupported",
						pause: "unknown-status",
					},
					{ id: "expired-held", mode: "seedance", hold: "unsupported", expires: 5 },
					{ id: "webm", mode: "seedance", hold: "webm" },
					{ id: "removed", mode: "h3", hold: "removed" },
					{ id: "failed", mode: "seedance", hold: "failed" },
					{ id: "image-unsupported", mode: "image", hold: "unsupported" },
					{ id: "has-item", mode: "seedance", hold: "unsupported" },
				]);
				await db.run(sql`INSERT INTO gallery_image
					(job_id,state,mime,width,height,size,digest,saved_at,duration,file_identity)
					VALUES ('has-item','unavailable','image/png',1,1,1,'d',3,NULL,NULL)`);
			},
			undefined,
			saveLimitHistory,
		);
		// 15.5 s under H3 Max's 15 s, 25 s and 31.5 s under Seedance's 30 s.
		const clips = {
			"h3-long": retimeClip(h3MaxShape(), 31, 4),
			"seedance-long": retimeClip(h3MaxShape(), 25, 2),
			"still-long": retimeClip(h3MaxShape(), 63, 4),
		};
		const harness = upgradeHarness(directory, clips, {
			"flag-overwritten": { type: "image", data: [{ url: "https://93.184.216.34/image.png" }] },
		});

		// The upgrade alone re-arms the held video rows that now have a limit.
		const upgraded = await openRuntimeInstallation(directory);
		try {
			expect(await upgraded.use((db) => schemaFingerprint(db))).toBe(currentSchema);
			const rows = await upgraded.use((db) =>
				db.all<{ id: string; save_due: number | null; save_hold: string | null }>(
					sql`SELECT id, save_due, save_hold FROM image_job ORDER BY id`,
				),
			);
			expect(
				Object.fromEntries(rows.map((row) => [row.id, [row.save_due, row.save_hold]])),
			).toEqual({
				"expired-held": [0, null],
				failed: [null, "failed"],
				"flag-overwritten": [0, null],
				"h3-long": [0, null],
				"has-item": [null, "unsupported"],
				"image-unsupported": [null, "unsupported"],
				"legacy-long": [null, "unsupported"],
				"provider-flagged": [null, "unsupported"],
				removed: [null, "removed"],
				"seedance-long": [0, null],
				"still-long": [0, null],
				webm: [null, "webm"],
			});
		} finally {
			await upgraded.close();
		}
		await harness.saveKeys();

		await harness.run(async (jobs, installation) => {
			expect(harness.state.requests.toSorted()).toEqual([
				"GET /api/generate/status/h3-long-task",
				"GET /v1/videos/generations/seedance-long-task",
				"GET /v1/videos/generations/still-long-task",
			]);
			expect(harness.state.transfers.toSorted()).toEqual([
				"/h3-long.mp4",
				"/seedance-long.mp4",
				"/still-long.mp4",
			]);
			expect(await harness.library(jobs)).toEqual({
				"expired-held": "expired",
				failed: "failed",
				"flag-overwritten": "paused",
				"h3-long": "saved",
				"has-item": "unavailable",
				"image-unsupported": "unsupported",
				"legacy-long": "unsupported",
				"provider-flagged": "unsupported",
				removed: "removed",
				"seedance-long": "saved",
				"still-long": "unsupported",
				webm: "webm",
			});
			const gallery = galleryStorage(installation);
			for (const id of ["h3-long", "seedance-long"] as const) {
				const saved = await gallery.openVideo(id);
				try {
					expect(await saved?.handle.readFile()).toEqual(clips[id]);
				} finally {
					await saved?.handle.close();
				}
			}
			// Past the provider's read spacing, Refresh reads the overwritten row once; the
			// provider still reports no video.
			harness.state.now = harness.start + 60_000;
			await jobs.refresh("flag-overwritten");
			expect((await harness.library(jobs))["flag-overwritten"]).toBe("unsupported");
		});
		expect(harness.state.requests).toHaveLength(4);
		expect(harness.state.requests).toContain("GET /v1/videos/generations/flag-overwritten-task");

		// A restart reads and downloads nothing more.
		await harness.run();
		expect(harness.state.requests).toHaveLength(4);
		expect(harness.state.transfers).toHaveLength(3);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}, 30_000);

test("from the release before real-clip Save, both re-arms together read each held clip once", async () => {
	const directory = await createOwnerDirectory();
	try {
		await createInstallation37(
			directory,
			(db) =>
				insertHeld(db, [
					{ id: "h3-long", mode: "h3", hold: "unsupported" },
					{ id: "seedance-long", mode: "seedance", hold: "unsupported" },
					// The real-clip re-arm reads it once; it keeps the 12-second rule and is held again.
					{ id: "legacy-long", mode: "unknown", hold: "unsupported" },
				]),
			undefined,
			realClipHistory,
		);
		const clips = {
			"h3-long": retimeClip(h3MaxShape(), 31, 4),
			"seedance-long": retimeClip(h3MaxShape(), 25, 2),
			"legacy-long": retimeClip(h3MaxShape(), 31, 4),
		};
		const harness = upgradeHarness(directory, clips);
		await harness.saveKeys();
		await harness.run(async (jobs) => {
			expect(await harness.library(jobs)).toEqual({
				"h3-long": "saved",
				"legacy-long": "unsupported",
				"seedance-long": "saved",
			});
		});
		expect(harness.state.requests.toSorted()).toEqual([
			"GET /api/generate/status/h3-long-task",
			"GET /v1/videos/generations/legacy-long-task",
			"GET /v1/videos/generations/seedance-long-task",
		]);
		await harness.run();
		expect(harness.state.requests).toHaveLength(3);
		expect(harness.state.transfers).toHaveLength(3);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}, 30_000);
