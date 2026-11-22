import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, copyFile, open, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { createOwnerDirectory } from "../../../../../tests/fixtures/owner-directory";
import { referenceGif, referencePng } from "../../../../../tests/fixtures/reference-image";
import { type Installation, openInstallation } from "../../db/installation";
import { createGallery } from "./gallery";

let directory: string;
let installation: Installation;
let gallery: ReturnType<typeof createGallery>;
const jobId = "16759492-59c3-41fe-8334-46e01dd75ffe";
let statusReads: number;
let downloads: number;
let remote = referencePng;
const galleryFiles = async () =>
	(await readdir(directory)).filter((name) => name.startsWith("gallery-"));

beforeEach(async () => {
	directory = await createOwnerDirectory();
	installation = await openInstallation(directory);
	statusReads = 0;
	downloads = 0;
	remote = referencePng;
	gallery = createGallery(
		installation,
		async () => {
			statusReads++;
			return "https://cdn.example/private-signed-url";
		},
		async () => {
			downloads++;
			return remote;
		},
	);
});
afterEach(async () => {
	await installation?.close();
	await rm(directory, { recursive: true, force: true });
});

test("concurrent saves publish one original image, then restart and removal stay offline", async () => {
	expect(await Promise.all([gallery.save(jobId), gallery.save(jobId)])).toEqual([true, true]);
	expect(await gallery.save(jobId)).toBe(true);
	expect(statusReads).toBe(1);
	expect(downloads).toBe(1);
	expect((await gallery.list()).map((entry) => entry.jobId)).toEqual([jobId]);
	expect(await galleryFiles()).toHaveLength(1);
	await installation.close();
	installation = await openInstallation(directory);
	const offline = createGallery(installation, async () => {
		throw new Error("offline");
	});
	await offline.recover();
	expect((await offline.read(jobId))?.bytes).toEqual(referencePng);
	expect(await offline.remove(jobId)).toBe(true);
	await offline.recover();
	expect(await offline.list()).toEqual([]);
	expect(await galleryFiles()).toEqual([]);
});

test("failed image verification leaves the job eligible for another save", async () => {
	remote = Buffer.from("expired or incomplete");
	expect(await gallery.save(jobId)).toBe(false);
	expect(await gallery.list()).toEqual([]);
	expect(await galleryFiles()).toEqual([]);
	remote = referencePng;
	expect(await gallery.save(jobId)).toBe(true);
});

test("recovery discards unindexed writes and finishes interrupted deletion", async () => {
	await gallery.save(jobId);
	const orphan = join(directory, `gallery-${"a".repeat(64)}`);
	await writeFile(orphan, "partial");
	await installation.use((db) =>
		db.run(sql`UPDATE gallery_image SET state='deleting' WHERE job_id=${jobId}`),
	);
	await gallery.recover();
	expect(await gallery.list()).toEqual([]);
	expect(await galleryFiles()).toEqual([]);
	expect(statusReads).toBe(1);
});

test("missing saved files show as unavailable and can be saved again", async () => {
	await gallery.save(jobId);
	const [filename] = await galleryFiles();
	await rm(join(directory, filename));
	expect(await gallery.list()).toMatchObject([{ jobId, available: false }]);
	expect(await gallery.read(jobId)).toBeNull();
	expect(await gallery.save(jobId)).toBe(true);
	expect(await gallery.list()).toMatchObject([{ jobId, available: true }]);
	expect(statusReads).toBe(2);
});

test("startup cleans a partial replacement of an unavailable file and preserves the entry", async () => {
	await gallery.save(jobId);
	const [name] = await galleryFiles();
	await rm(join(directory, name));
	await gallery.list();
	await writeFile(join(directory, name), "partial repair");
	await gallery.recover();
	expect(await galleryFiles()).toEqual([]);
	expect(await gallery.list()).toMatchObject([{ jobId, available: false }]);
});

test("a complete unsupported result survives restart until publication succeeds", async () => {
	await installation.use((db) =>
		db.run(sql`INSERT INTO image_job
		(id,binding,provider,revision,quote,state,model,created_at,poll_deadline)
		VALUES (${jobId},'binding','poyo',1,'{}','completed','z-image',0,120000)`),
	);
	const reason = () =>
		installation.use((db) =>
			db.get(sql`SELECT gallery_reason, state FROM image_job WHERE id=${jobId}`),
		);
	remote = referencePng.subarray(0, -12);
	expect(await gallery.save(jobId)).toBe(false);
	expect(await reason()).toEqual({ gallery_reason: null, state: "completed" });
	expect(await gallery.list()).toEqual([]);
	remote = referenceGif;
	await installation.use((db) =>
		db.run(sql`CREATE TRIGGER refuse_reason BEFORE UPDATE OF gallery_reason ON image_job
			BEGIN SELECT RAISE(ABORT, 'fixture write refusal'); END`),
	);
	expect(await gallery.save(jobId)).toBe(false);
	expect(await reason()).toEqual({ gallery_reason: null, state: "completed" });
	await installation.use((db) => db.run(sql`DROP TRIGGER refuse_reason`));
	expect(await gallery.save(jobId)).toBe(false);
	await installation.close();
	installation = await openInstallation(directory);
	expect(await reason()).toEqual({ gallery_reason: "unsupported-image", state: "completed" });
	const reopened = createGallery(
		installation,
		async (id) => (id === jobId ? "fixture" : null),
		async () => referencePng,
	);
	expect(await reopened.save(jobId)).toBe(true);
	expect(await reason()).toEqual({ gallery_reason: null, state: "completed" });
});

test("video identity reconciliation leaves the installation connection available", async () => {
	const digest = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
	const bytes = await readFile(
		join(import.meta.dir, "../../../../../tests/fixtures/video/silent.mp4"),
	);
	const path = join(directory, `gallery-${digest(jobId)}`);
	await writeFile(path, bytes);
	await installation.use((db) =>
		db.run(sql`INSERT INTO gallery_image
		(job_id,state,mime,width,height,size,digest,saved_at,duration,file_identity)
		VALUES (${jobId},'saved','video/mp4',320,240,${bytes.length},${digest(bytes)},1,2,'previous-identity')`),
	);

	const probe = await open(path);
	const proto = Object.getPrototypeOf(probe);
	await probe.close();
	const readBytes = proto.read;
	for (const action of ["list", "get", "openVideo"] as const) {
		await copyFile(path, `${path}.restore`);
		await rename(`${path}.restore`, path);
		expect(await gallery.openVideo(jobId, true)).toBeNull();
		let connectionAvailable = false;
		const read = spyOn(proto, "read").mockImplementationOnce(async function (
			this: typeof probe,
			...args: unknown[]
		) {
			connectionAvailable = await Promise.race([
				installation.use(async () => true),
				new Promise<false>((resolve) => setImmediate(() => resolve(false))),
			]);
			return readBytes.apply(this, args);
		});
		try {
			if (action === "list") expect(await gallery.list()).toMatchObject([{ available: true }]);
			if (action === "get") expect(await gallery.get(jobId)).toMatchObject({ available: true });
			if (action === "openVideo") {
				const video = await gallery.openVideo(jobId);
				try {
					expect(await video?.handle.readFile()).toEqual(bytes);
				} finally {
					await video?.handle.close();
				}
			}
			expect(connectionAvailable).toBe(true);
		} finally {
			read.mockRestore();
		}
		const rebound = await gallery.openVideo(jobId, true);
		expect(rebound).not.toBeNull();
		await rebound?.handle.close();
	}
	await copyFile(path, `${path}.restore`);
	await rename(`${path}.restore`, path);
	await gallery.recover();
	const recovered = await gallery.openVideo(jobId, true);
	expect(recovered).not.toBeNull();
	await recovered?.handle.close();
	if (process.platform !== "win32") {
		await chmod(path, 0o400);
		expect(await gallery.openVideo(jobId, true)).toBeNull();
		expect((await gallery.get(jobId))?.available).toBe(true);
		await chmod(path, 0o600);
	}
	await writeFile(path, Buffer.alloc(bytes.length));
	expect(await gallery.openVideo(jobId)).toBeNull();
	expect((await gallery.get(jobId))?.available).toBe(false);
});
