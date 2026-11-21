import { afterEach, beforeEach, expect, test } from "bun:test";
import { readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { createOwnerDirectory } from "../../../../../tests/fixtures/owner-directory";
import { referencePng } from "../../../../../tests/fixtures/reference-image";
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
