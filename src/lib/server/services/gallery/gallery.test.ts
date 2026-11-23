import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	chmod,
	copyFile,
	mkdir,
	open,
	readdir,
	readFile,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { createOwnerDirectory } from "../../../../../tests/fixtures/owner-directory";
import { referencePng } from "../../../../../tests/fixtures/reference-image";
import { h264Aac } from "../../../../../tests/fixtures/video/mp4-boxes";
import { providerStore } from "../../db/provider-store";
import { openRuntimeInstallation, type RuntimeInstallation } from "../../db/runtime-installation";
import { saveIntentStore } from "../../db/save-intent";
import { verifyVideoFile } from "../video-media/verify-video";
import { createGallery } from "./gallery";
import { galleryStorage } from "./storage";
import { verifyImage } from "./verify-image";

let directory: string;
let installation: RuntimeInstallation;
let gallery: ReturnType<typeof createGallery>;
const jobId = "16759492-59c3-41fe-8334-46e01dd75ffe";
const galleryFiles = async () =>
	(await readdir(directory)).filter((name) => name.startsWith("gallery-"));
const digest = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

beforeEach(async () => {
	directory = await createOwnerDirectory();
	installation = await openRuntimeInstallation(directory);
	await providerStore(installation).save("poyo", "fixture-key", Date.now(), true, 0);
	gallery = createGallery(installation);
});
afterEach(async () => {
	await installation?.close();
	await rm(directory, { recursive: true, force: true });
});

/** A completed job whose save intent this test claims, as the worker would. */
async function claim(id = jobId, model = "seedream-5.5") {
	await installation.use((db) =>
		db.run(sql`INSERT OR IGNORE INTO image_job
			(id,binding,provider,revision,quote,state,model,created_at,poll_deadline,video_terms)
			VALUES (${id},${id},'poyo',1,'{}','completed',${model},0,120000,${model === "h3-max" ? "[]" : null})`),
	);
	await installation.use((db) =>
		db.run(
			sql`UPDATE image_job SET save_due=COALESCE(save_due,0) WHERE id=${id} AND save_hold IS NULL`,
		),
	);
	const token = crypto.randomUUID();
	return (await saveIntentStore(installation).claim(id, token, Date.now())) ? token : null;
}
const intent = (id = jobId) =>
	installation.use((db) =>
		db.get(sql`SELECT save_due, save_hold, save_attempt, save_tries FROM image_job WHERE id=${id}`),
	);
async function publishImage(token: string | null, id = jobId) {
	return galleryStorage(installation).publish(
		id,
		token ?? "",
		referencePng,
		await verifyImage(referencePng),
	);
}
async function publishVideo(token: string | null, id = jobId) {
	const storage = galleryStorage(installation);
	const path = storage.scratchPath(token ?? crypto.randomUUID());
	const bytes = h264Aac();
	await writeFile(path, bytes, { mode: 0o600 });
	try {
		return await storage.publishVideo(id, path, token ?? "", {
			...(await verifyVideoFile(path)),
			size: bytes.length,
			digest: digest(bytes),
		});
	} finally {
		await rm(path, { force: true });
	}
}

test("a claimed save publishes one original image, then restart and removal stay offline", async () => {
	const token = await claim();
	const [first, second] = await Promise.all([publishImage(token), publishImage(token)]);
	expect([first, second].sort()).toEqual(["fenced", "saved"]);
	expect(await intent()).toEqual({
		save_due: null,
		save_hold: null,
		save_attempt: null,
		save_tries: 0,
	});
	expect((await gallery.list()).map((entry) => entry.jobId)).toEqual([jobId]);
	expect(await galleryFiles()).toHaveLength(1);
	await installation.close();
	installation = await openRuntimeInstallation(directory);
	const offline = createGallery(installation);
	await offline.recover();
	expect((await offline.read(jobId))?.bytes).toEqual(referencePng);
	expect(await offline.remove(jobId)).toBe(true);
	expect(await intent()).toMatchObject({ save_hold: "removed", save_due: null });
	await offline.recover();
	expect(await offline.list()).toEqual([]);
	expect(await galleryFiles()).toEqual([]);
});

test("an existing publication still clears the intent", async () => {
	expect(await publishImage(await claim())).toBe("saved");
	await installation.use((db) => db.run(sql`DELETE FROM gallery_image WHERE job_id=${jobId}`));
	const token = await claim();
	await installation.use((db) =>
		db.run(sql`INSERT INTO gallery_image (job_id,state,mime,width,height,size,digest,saved_at)
			VALUES (${jobId},'saved','image/png',1,1,${referencePng.length},${digest(referencePng)},1)`),
	);
	expect(await publishImage(token)).toBe("saved");
	expect(await intent()).toEqual({
		save_due: null,
		save_hold: null,
		save_attempt: null,
		save_tries: 0,
	});
});

test("Remove fences an image or video attempt, and Download again saves under a new claim", async () => {
	for (const [id, model, publish] of [
		["image", "seedream-5.5", publishImage],
		["video", "h3-max", publishVideo],
	] as const) {
		const old = await claim(id, model);
		await gallery.remove(id);
		expect(await publish(old, id), id).toBe("fenced");
		expect(await gallery.get(id)).toBeNull();
		expect(await intent(id)).toEqual({
			save_due: null,
			save_hold: "removed",
			save_attempt: null,
			save_tries: 0,
		});
		expect(await saveIntentStore(installation).retry(id, Date.now())).toBe(true);
		const fresh = await claim(id, model);
		expect(await publish(old, id), id).toBe("fenced");
		expect(await publish(fresh, id), id).toBe("saved");
		expect((await gallery.get(id))?.available).toBe(true);
	}
	expect((await readdir(directory)).filter((name) => name.endsWith(".part"))).toEqual([]);
});

test("a key replaced before publication fences the attempt", async () => {
	const token = await claim();
	await providerStore(installation).save("poyo", "replacement", Date.now(), true, 1);
	expect(await publishImage(token)).toBe("fenced");
	expect(await gallery.list()).toEqual([]);
	expect(await intent()).toMatchObject({ save_attempt: token, save_due: 0 });
});

test("a failed directory sync publishes no Gallery row", async () => {
	const token = await claim();
	const probe = await open(directory, "r");
	const proto = Object.getPrototypeOf(probe);
	await probe.close();
	const syncFile = proto.sync;
	const sync = spyOn(proto, "sync").mockImplementation(async function (this: typeof probe) {
		if ((await this.stat()).isDirectory())
			throw Object.assign(new Error("Fixture directory sync failed"), { code: "EIO" });
		return syncFile.apply(this);
	});
	try {
		await expect(publishImage(token)).rejects.toThrow("Fixture directory sync failed");
	} finally {
		sync.mockRestore();
	}
	expect(await gallery.list()).toEqual([]);
	expect(await galleryFiles()).toEqual([]);
	expect(await installation.use((db) => db.all(sql`SELECT job_id FROM gallery_image`))).toEqual([]);
	expect(await intent()).toMatchObject({ save_attempt: token, save_due: 0 });
});

test("recovery discards unindexed writes and video scratch and finishes interrupted deletion", async () => {
	await publishImage(await claim());
	const orphan = join(directory, `gallery-${"a".repeat(64)}`);
	await writeFile(orphan, "partial");
	const leftover = `video-${crypto.randomUUID()}.part`;
	const stuck = `video-${crypto.randomUUID()}.part`;
	await writeFile(join(directory, leftover), "incomplete");
	await mkdir(join(directory, stuck, "child"), { recursive: true });
	await installation.use((db) =>
		db.run(sql`UPDATE gallery_image SET state='deleting' WHERE job_id=${jobId}`),
	);
	const logged = spyOn(console, "error").mockImplementation(() => {});
	try {
		await gallery.recover();
		expect(logged.mock.calls).toEqual([[`Unable to remove leftover video scratch ${stuck}.`]]);
	} finally {
		logged.mockRestore();
	}
	expect(await gallery.list()).toEqual([]);
	expect(await galleryFiles()).toEqual([]);
	expect((await readdir(directory)).filter((name) => name.endsWith(".part"))).toEqual([stuck]);
});

test("missing saved files show as unavailable and save again only through Download again", async () => {
	await publishImage(await claim());
	const [filename] = await galleryFiles();
	await rm(join(directory, filename));
	expect(await gallery.list()).toMatchObject([{ jobId, available: false }]);
	expect(await gallery.read(jobId)).toBeNull();
	expect(await claim()).toBeNull();
	expect(await saveIntentStore(installation).retry(jobId, Date.now())).toBe(true);
	expect(await publishImage(await claim())).toBe("saved");
	expect(await gallery.list()).toMatchObject([{ jobId, available: true }]);
});

test("startup cleans a partial replacement of an unavailable file and preserves the entry", async () => {
	await publishImage(await claim());
	const [name] = await galleryFiles();
	await rm(join(directory, name));
	await gallery.list();
	await writeFile(join(directory, name), "partial repair");
	await gallery.recover();
	expect(await galleryFiles()).toEqual([]);
	expect(await gallery.list()).toMatchObject([{ jobId, available: false }]);
});

test("video identity reconciliation leaves the installation connection available", async () => {
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
	await chmod(path, 0o400);
	expect(await gallery.openVideo(jobId, true)).toBeNull();
	expect((await gallery.get(jobId))?.available).toBe(true);
	await chmod(path, 0o600);
	await writeFile(path, Buffer.alloc(bytes.length));
	expect(await gallery.openVideo(jobId)).toBeNull();
	expect((await gallery.get(jobId))?.available).toBe(false);
});
