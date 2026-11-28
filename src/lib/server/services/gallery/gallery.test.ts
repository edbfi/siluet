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
import { imageResponse } from "./image-response";
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
			...(await verifyVideoFile(path, null)),
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

/** Publish `count` saved images, each a distinct job, and return their IDs. */
async function savedImages(count: number) {
	const ids = Array.from({ length: count }, () => crypto.randomUUID());
	for (const id of ids) expect(await publishImage(await claim(id), id)).toBe("saved");
	return ids;
}
const live = () => new AbortController().signal;
/** Wait until `done()` holds, then a little longer so nothing past it can slip in. */
async function until(done: () => boolean) {
	for (let i = 0; i < 400 && !done(); i++) await Bun.sleep(5);
	await Bun.sleep(25);
}

test("one stalled reader holds one permit while other reads proceed through the other", async () => {
	const [stalled, ...others] = await savedImages(4);
	const held = await gallery.openImage(stalled, live());
	expect(held).toMatchObject({ mime: "image/png", size: referencePng.length });
	for (const id of others) {
		const image = await gallery.openImage(id, live());
		expect(image?.bytes).toEqual(referencePng);
		image?.release();
	}
	held?.release();
});

test("six concurrent reads never hold more than two buffers, and each body matches its saved file", async () => {
	const ids = await savedImages(6);
	let holding = 0;
	let peak = 0;
	const responses = ids.map(async (id) => {
		const image = await gallery.openImage(id, live());
		if (!image) throw new Error("Expected a saved image.");
		peak = Math.max(peak, ++holding);
		const release = image.release;
		image.release = () => {
			holding--;
			release();
		};
		return imageResponse(image, new URL(`http://studio.test/gallery/${id}/media`), "a.png");
	});
	await until(() => holding === 2);
	expect(holding).toBe(2);
	for (const response of responses) {
		const answer = await response;
		const body = Buffer.from(await answer.arrayBuffer());
		expect(answer.headers.get("x-siluet-length")).toBe(String(body.length));
		expect(digest(body)).toBe(digest(referencePng));
	}
	expect([peak, holding]).toEqual([2, 0]);
});

test("a finished or cancelled body releases its permit and drops its buffer", async () => {
	const [first, second, third] = await savedImages(3);
	const url = new URL("http://studio.test/gallery/x/media");
	const finished = await gallery.openImage(first, live());
	const cancelled = await gallery.openImage(second, live());
	if (!finished || !cancelled) throw new Error("Expected saved images.");
	let admitted = false;
	const waiting = gallery.openImage(third, live()).then((image) => {
		admitted = true;
		return image;
	});
	await (await imageResponse(finished, url, "a.png")).arrayBuffer();
	expect(finished.bytes).toBeNull();
	await until(() => admitted);
	expect(admitted).toBe(true);
	await imageResponse(cancelled, url, "a.png").body?.cancel();
	expect(cancelled.bytes).toBeNull();
	(await waiting)?.release();
	// Both permits are free again.
	const again = await Promise.all([first, second].map((id) => gallery.openImage(id, live())));
	for (const image of again) image?.release();
});

test("an aborted request cancels its queued wait for a permit", async () => {
	const ids = await savedImages(3);
	const held = await Promise.all(ids.slice(0, 2).map((id) => gallery.openImage(id, live())));
	const request = new AbortController();
	const queued = gallery.openImage(ids[2], request.signal);
	request.abort(new Error("The client went away."));
	await expect(queued).rejects.toThrow("The client went away.");
	for (const image of held) image?.release();
	const next = await gallery.openImage(ids[2], live());
	expect(next?.bytes).toEqual(referencePng);
	next?.release();
});

test("a permit handed to an aborted request, or held while its request aborts during the read, is released", async () => {
	const ids = await savedImages(3);
	const [first, second] = await Promise.all(
		ids.slice(0, 2).map((id) => gallery.openImage(id, live())),
	);
	const handed = new AbortController();
	const queued = gallery.openImage(ids[2], handed.signal);
	// The permit passes to the queued request just as it aborts.
	first?.release();
	handed.abort(new Error("The client went away."));
	await expect(queued).rejects.toThrow("The client went away.");
	second?.release();

	const probe = await open(directory, "r");
	const proto = Object.getPrototypeOf(probe);
	await probe.close();
	const readFileBytes = proto.readFile;
	const reading = new AbortController();
	const read = spyOn(proto, "readFile").mockImplementation(async function (
		this: typeof probe,
		...args: unknown[]
	) {
		reading.abort(new Error("The client left mid-read."));
		return readFileBytes.apply(this, args);
	});
	try {
		await expect(gallery.openImage(ids[0], reading.signal)).rejects.toThrow(
			"The client left mid-read.",
		);
	} finally {
		read.mockRestore();
	}
	// Both permits are free: two reads open at once without waiting.
	const again = await Promise.all(ids.slice(0, 2).map((id) => gallery.openImage(id, live())));
	expect(again.map((image) => image?.bytes)).toEqual([referencePng, referencePng]);
	for (const image of again) image?.release();
});

test("an image read leaves the installation connection free during file I/O", async () => {
	const [id] = await savedImages(1);
	const probe = await open(directory, "r");
	const proto = Object.getPrototypeOf(probe);
	await probe.close();
	const readFileBytes = proto.readFile;
	let connectionAvailable = false;
	const read = spyOn(proto, "readFile").mockImplementation(async function (
		this: typeof probe,
		...args: unknown[]
	) {
		connectionAvailable = await Promise.race([
			installation.use(async () => true),
			new Promise<false>((resolve) => setImmediate(() => resolve(false))),
		]);
		return readFileBytes.apply(this, args);
	});
	try {
		const image = await gallery.openImage(id, live());
		expect(image?.bytes).toEqual(referencePng);
		image?.release();
		expect(connectionAvailable).toBe(true);
		connectionAvailable = false;
		expect((await gallery.read(id))?.bytes).toEqual(referencePng);
		expect(connectionAvailable).toBe(true);
	} finally {
		read.mockRestore();
	}
});

test("HEAD checks the row and the file size and reads no file body", async () => {
	const [id, missing] = await savedImages(2);
	const probe = await open(directory, "r");
	const proto = Object.getPrototypeOf(probe);
	await probe.close();
	const reads = [spyOn(proto, "read"), spyOn(proto, "readFile")];
	try {
		expect(await gallery.headImage(id)).toEqual({ mime: "image/png", size: referencePng.length });
		await rm(join(directory, `gallery-${digest(missing)}`));
		expect(await gallery.headImage(missing)).toBeNull();
		expect(await gallery.headImage(crypto.randomUUID())).toBeNull();
		for (const spy of reads) expect(spy).not.toHaveBeenCalled();
	} finally {
		for (const spy of reads) spy.mockRestore();
	}
	expect((await gallery.get(missing))?.available).toBe(false);
});
