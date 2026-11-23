import { afterEach, beforeEach, expect, test } from "bun:test";
import { readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { createOwnerDirectory } from "../../../../../tests/fixtures/owner-directory";
import { referenceGif, referencePng } from "../../../../../tests/fixtures/reference-image";
import { h264Aac } from "../../../../../tests/fixtures/video/mp4-boxes";
import { providerKeyFilename } from "../../db/provider-key";
import { providerStore } from "../../db/provider-store";
import { openRuntimeInstallation, type RuntimeInstallation } from "../../db/runtime-installation";
import { saveIntentStore } from "../../db/save-intent";
import type { CheckFetch } from "../../providers/connection-check";
import { createJobTracking } from "../jobs/tracking";
import { downloadVideo } from "../video-media/download";
import { createAutoSave } from "./auto-save";
import { downloadImage, type Transport } from "./download";
import { createGallery } from "./gallery";

const start = 1_800_000_000_000;
const credential = "fixture-key-sentinel";
const signed = (id: string) => `https://cdn.example.net/${id}?sig=signed-result-sentinel`;
const video = h264Aac();
let now: number;
let directory: string;
let installation: RuntimeInstallation;
let runtime: ReturnType<typeof open> | undefined;
let reads: string[];
let posts: number;
let transfers: string[];
let status: (id: string) => Response;
let media: (id: string) => Response | Promise<Response>;

beforeEach(async () => {
	now = start;
	reads = [];
	posts = 0;
	transfers = [];
	status = (id) => finished(id);
	media = (id) => new Response(id.startsWith("video") ? video : referencePng);
	directory = await createOwnerDirectory();
	installation = await openRuntimeInstallation(directory);
	await providerStore(installation).save("poyo", credential, now, true, 0);
});
afterEach(async () => {
	await runtime?.close();
	runtime = undefined;
	await installation.close();
	await rm(directory, { recursive: true, force: true });
});

const finished = (id: string, url: string | null = signed(id)) =>
	Response.json({
		code: 200,
		data: {
			task_id: `${id}-task`,
			status: "finished",
			files: url ? [{ file_type: id.startsWith("video") ? "video" : "image", file_url: url }] : [],
		},
	});
const fetch: CheckFetch = async (url, init) => {
	if (init.method === "POST") posts++;
	const id =
		url
			.split("/")
			.at(-1)
			?.replace(/-task$/, "") ?? "";
	reads.push(id);
	return status(id);
};
const transport: Transport = {
	resolve: async () => "93.184.216.34",
	request: async (url) => {
		const id = url.pathname.slice(1);
		transfers.push(id);
		return media(id);
	},
};

type Overrides = Partial<Parameters<typeof createAutoSave>[1]>;
function open(overrides: Overrides = {}) {
	const store = providerStore(installation);
	const handoffs: [string, boolean][] = [];
	const jobs = createJobTracking(installation, store, {
		fetch,
		now: () => now,
		random: () => 0,
		scheduleRead: () => () => {},
		onDelivery: (id, delivery, armed) => {
			handoffs.push([id, armed]);
			autoSave.deliver(id, delivery, armed);
		},
	});
	const autoSave = createAutoSave(installation, {
		readForSave: jobs.readForSave,
		readability: store.jobReadability,
		now: () => now,
		transport,
		...overrides,
	});
	const gallery = createGallery(installation);
	return {
		jobs,
		autoSave,
		gallery,
		handoffs,
		async start() {
			await gallery.recover();
			await saveIntentStore(installation).clearAbandoned();
			await jobs.resume();
			autoSave.start();
			await settle(this);
		},
		async close() {
			jobs.close();
			await autoSave.close();
		},
	};
}
async function settle(target = runtime) {
	await Bun.sleep(5);
	await target?.autoSave.idle();
}
async function reopen(overrides: Overrides = {}) {
	await runtime?.close();
	await installation.close();
	installation = await openRuntimeInstallation(directory);
	runtime = open(overrides);
	await runtime.start();
	return runtime;
}
async function insert(id: string, state = "running") {
	const isVideo = id.startsWith("video");
	await installation.use((db) =>
		db.run(sql`INSERT INTO image_job
			(id,binding,provider,revision,quote,state,model,created_at,poll_deadline,submission_recorded_at,task_id,next_read_at,video_terms)
			VALUES (${id},${id},'poyo',1,'{}',${state},${isVideo ? "h3-max" : "seedream-5.5"},${now},${now + 120_000},
			${now},${`${id}-task`},${now},${isVideo ? "[]" : null})`),
	);
}
const job = (id: string) =>
	installation.use((db) =>
		db.get<{
			save_due: number | null;
			save_hold: string | null;
			save_attempt: string | null;
			save_tries: number;
		}>(sql`SELECT save_due, save_hold, save_attempt, save_tries FROM image_job WHERE id=${id}`),
	);
const summary = async (id: string) => (await runtime?.jobs.list())?.find((row) => row.id === id);
const leftovers = async () =>
	(await readdir(directory)).filter(
		(name) => name.endsWith(".part") || name.startsWith("gallery-"),
	);
async function complete(...ids: string[]) {
	for (const id of ids) await insert(id);
	for (const id of ids) await runtime?.jobs.refresh(id);
	await settle();
}

test("a completed image and video save with no click and no extra status read", async () => {
	runtime = open();
	await runtime.start();
	await complete("image", "video");
	expect(reads).toEqual(["image", "video"]);
	expect(runtime.handoffs).toEqual([
		["image", true],
		["video", true],
	]);
	expect(await summary("image")).toMatchObject({ library: "saved", retryable: false });
	expect((await runtime.gallery.read("image"))?.bytes).toEqual(referencePng);
	const saved = await runtime.gallery.openVideo("video");
	try {
		expect(await saved?.handle.readFile()).toEqual(video);
	} finally {
		await saved?.handle.close();
	}
	expect(await job("image")).toEqual({
		save_due: null,
		save_hold: null,
		save_attempt: null,
		save_tries: 0,
	});
	// Refresh on a saved job hands nothing over and downloads nothing.
	now += 10_000;
	await runtime.jobs.refresh("image");
	await settle();
	expect(runtime.handoffs).toHaveLength(2);
	expect(transfers).toEqual(["image", "video"]);
	expect(posts).toBe(0);
});

test("duplicate handoffs transfer once and at most two images and one video run together", async () => {
	const gate = Promise.withResolvers<void>();
	let peak = { image: 0, video: 0 };
	const running = { image: 0, video: 0 };
	const track = async <T>(kind: "image" | "video", work: () => Promise<T>) => {
		running[kind]++;
		peak = {
			image: Math.max(peak.image, running.image),
			video: Math.max(peak.video, running.video),
		};
		await gate.promise;
		try {
			return await work();
		} finally {
			running[kind]--;
		}
	};
	runtime = open({
		transferImage: (url, t, signal) => track("image", () => downloadImage(url, t, signal)),
		transferVideo: (source, path, t, signal) =>
			track("video", () => downloadVideo(source, path, t, signal)),
	});
	await runtime.start();
	const ids = ["image-1", "image-2", "image-3", "video-1", "video-2"];
	for (const id of ids) await insert(id);
	// The query gate allows two status reads a second.
	for (const [index, id] of ids.entries()) {
		now = start + Math.floor(index / 2) * 1_000;
		await runtime.jobs.refresh(id);
	}
	runtime.autoSave.deliver("image-1", { url: signed("image-1"), fallback: null }, false);
	await Bun.sleep(20);
	expect(running).toEqual({ image: 2, video: 1 });
	gate.resolve();
	await settle();
	expect(peak).toEqual({ image: 2, video: 1 });
	expect(transfers.sort()).toEqual([...ids].sort());
	for (const id of ids) expect((await summary(id))?.library, id).toBe("saved");
});

test("a backfilled batch of three waits for the read gate without counting a try", async () => {
	runtime = open();
	for (const id of ["image-1", "image-2", "image-3"]) {
		await insert(id, "completed");
		await installation.use((db) => db.run(sql`UPDATE image_job SET save_due=0 WHERE id=${id}`));
	}
	await runtime.start();
	expect(reads.toSorted()).toEqual(["image-1", "image-2"]);
	expect(await job("image-3")).toMatchObject({ save_due: start + 1_000, save_tries: 0 });
	expect(await summary("image-3")).toMatchObject({ library: "waiting" });
	now += 1_000;
	runtime.autoSave.start();
	await settle();
	expect(reads.toSorted()).toEqual(["image-1", "image-2", "image-3"]);
	for (const id of ["image-1", "image-2", "image-3"])
		expect((await summary(id))?.library).toBe("saved");
	expect(posts).toBe(0);
});

test("a crash after completion or after the claim recovers with one read, also inside a cooldown", async () => {
	runtime = open();
	await runtime.start();
	await insert("image");
	// The process stops after the completing read commits, before the worker runs.
	void runtime.autoSave.close();
	await runtime.jobs.refresh("image");
	expect(await job("image")).toMatchObject({ save_due: start, save_attempt: null });
	await reopen();
	// Restart inside the completing read's cooldown: the recovery read waits without a try.
	expect(reads).toEqual(["image"]);
	expect(await job("image")).toMatchObject({ save_due: start + 2_000, save_tries: 0 });
	now += 2_000;
	runtime.autoSave.start();
	await settle();
	expect(reads).toEqual(["image", "image"]);
	expect((await summary("image"))?.library).toBe("saved");

	// A claim left by a crash is cleared at startup and saved once.
	await insert("image-2", "completed");
	await installation.use((db) =>
		db.run(
			sql`UPDATE image_job SET save_due=0, save_attempt='crashed', next_read_at=0 WHERE id='image-2'`,
		),
	);
	await reopen();
	expect((await summary("image-2"))?.library).toBe("saved");
	expect(transfers).toEqual(["image", "image-2"]);
	expect(posts).toBe(0);
});

test("a key replaced before publication fences the attempt and keeps the job waiting for its key", async () => {
	media = (id) => {
		void providerStore(installation).save("poyo", "replacement", now, true, 1);
		return new Response(id.startsWith("video") ? video : referencePng);
	};
	runtime = open();
	await runtime.start();
	await complete("image");
	expect(await runtime.gallery.get("image")).toBeNull();
	expect(await job("image")).toMatchObject({
		save_due: start,
		save_hold: null,
		save_attempt: null,
	});
	expect(await summary("image")).toMatchObject({ library: "needs-key", retryable: false });
	runtime.autoSave.start();
	await settle();
	expect(transfers).toEqual(["image"]);
});

test("full disk fails three times for images and videos and leaves no partial file", async () => {
	const full = () => Object.assign(new Error("Fixture disk full"), { code: "ENOSPC" });
	runtime = open({
		transferImage: async () => {
			throw full();
		},
		transferVideo: async (_source, path) => {
			await writeFile(path, video.subarray(0, 100));
			throw full();
		},
	});
	await runtime.start();
	await complete("image", "video");
	for (const id of ["image", "video"]) {
		expect(await job(id)).toMatchObject({ save_due: start + 30_000, save_tries: 1 });
		expect(await summary(id)).toMatchObject({ library: "waiting" });
	}
	now += 30_000;
	runtime.autoSave.start();
	await settle();
	for (const id of ["image", "video"])
		expect(await job(id)).toMatchObject({ save_due: now + 120_000, save_tries: 2 });
	now += 120_000;
	runtime.autoSave.start();
	await settle();
	for (const id of ["image", "video"]) {
		expect(await job(id)).toEqual({
			save_due: null,
			save_hold: "failed",
			save_attempt: null,
			save_tries: 3,
		});
		expect(await summary(id)).toMatchObject({ library: "failed", retryable: true });
	}
	expect(await leftovers()).toEqual([]);
	// The database stays writable.
	expect(await runtime.autoSave.retry("image")).toBe(true);
	expect(reads).toEqual(["image", "video"]);
});

test("a CDN 404 three times ends in Download failed, then Retry download reads once and saves", async () => {
	let missing = true;
	media = (id) =>
		missing ? new Response(null, { status: 404 }) : new Response(referencePng, { headers: { id } });
	runtime = open();
	await runtime.start();
	await complete("image");
	for (const wait of [30_000, 120_000]) {
		now += wait;
		runtime.autoSave.start();
		await settle();
	}
	expect(transfers).toEqual(["image", "image", "image"]);
	expect(await summary("image")).toMatchObject({ library: "failed", retryable: true });
	expect(reads).toEqual(["image"]);
	missing = false;
	expect(await runtime.autoSave.retry("image")).toBe(true);
	await settle();
	expect(reads).toEqual(["image", "image"]);
	expect(await summary("image")).toMatchObject({ library: "saved" });
	expect(posts).toBe(0);
});

test("a completion without a usable link shows Download failed with no extra read", async () => {
	status = (id) => finished(id, null);
	runtime = open();
	await runtime.start();
	await complete("image", "video");
	expect(reads).toEqual(["image", "video"]);
	for (const id of ["image", "video"])
		expect(await job(id)).toMatchObject({ save_hold: "failed", save_due: null, save_tries: 0 });
	expect(transfers).toEqual([]);
	status = (id) => finished(id);
	now += 5_000;
	expect(await runtime.autoSave.retry("video")).toBe(true);
	await settle();
	expect(reads).toEqual(["image", "video", "video"]);
	expect((await summary("video"))?.library).toBe("saved");
});

test("an expired pending job is cleared without any request", async () => {
	await insert("image", "completed");
	await installation.use((db) =>
		db.run(sql`UPDATE image_job SET save_due=0, expires_at=${start - 1} WHERE id='image'`),
	);
	runtime = open();
	await runtime.start();
	expect(await job("image")).toMatchObject({ save_due: null, save_hold: null });
	expect(await summary("image")).toMatchObject({ library: "expired", retryable: false });
	expect([reads, transfers]).toEqual([[], []]);
});

test("a short body without Content-Length counts a try and never holds the job", async () => {
	media = (id) =>
		new Response(
			new Blob([
				id.startsWith("video") ? video.subarray(0, -100) : referencePng.subarray(0, -12),
			]).stream(),
		);
	runtime = open();
	await runtime.start();
	await complete("image", "video");
	for (const id of ["image", "video"])
		expect(await job(id)).toMatchObject({ save_hold: null, save_tries: 1 });
	expect(await leftovers()).toEqual([]);
});

test("complete files outside the profile are held as unsupported or WebM", async () => {
	const webm = Buffer.concat([
		Buffer.from("1a45dfa38b42868101428284", "hex"),
		Buffer.from("webm"),
		Buffer.alloc(32),
	]);
	media = (id) => new Response(id === "video-webm" ? webm : referenceGif);
	runtime = open();
	await runtime.start();
	await complete("image", "video-webm");
	expect(await summary("image")).toMatchObject({ library: "unsupported", retryable: false });
	expect(await summary("video-webm")).toMatchObject({ library: "webm", retryable: false });
	expect(await leftovers()).toEqual([]);
});

test("shutdown during a write releases the claim without a try and the next start saves once", async () => {
	const writing = Promise.withResolvers<void>();
	runtime = open({
		transferVideo: (source, path, _transport, signal) => {
			writing.resolve();
			return downloadVideo(
				source,
				path,
				{ resolve: async () => "93.184.216.34", request: () => new Promise<Response>(() => {}) },
				signal,
			);
		},
	});
	await runtime.start();
	await insert("video");
	await runtime.jobs.refresh("video");
	await writing.promise;
	await runtime.close();
	expect(await job("video")).toEqual({
		save_due: start,
		save_hold: null,
		save_attempt: null,
		save_tries: 0,
	});
	expect(await leftovers()).toEqual([]);
	now += 5_000;
	await reopen();
	expect((await summary("video"))?.library).toBe("saved");
	expect(transfers).toEqual(["video"]);
});

test("Remove during a transfer keeps the hold, and Download again saves while the old attempt unwinds", async () => {
	const holds: PromiseWithResolvers<void>[] = [];
	const arrived: PromiseWithResolvers<void>[] = [Promise.withResolvers(), Promise.withResolvers()];
	media = async (id) => {
		const hold = Promise.withResolvers<void>();
		holds.push(hold);
		arrived[holds.length - 1]?.resolve();
		await hold.promise;
		return new Response(id.startsWith("video") ? video : referencePng);
	};
	runtime = open();
	await runtime.start();
	for (const id of ["image", "video"]) {
		await insert(id);
		await runtime.jobs.refresh(id);
	}
	await Promise.all(arrived.map((entry) => entry.promise));
	await runtime.gallery.remove("image");
	await runtime.gallery.remove("video");
	expect(await runtime.autoSave.retry("image")).toBe(true);
	for (const hold of holds) hold.resolve();
	await settle();
	expect(await runtime.gallery.get("video")).toBeNull();
	expect(await job("video")).toMatchObject({
		save_hold: "removed",
		save_due: null,
		save_attempt: null,
	});
	expect(await summary("video")).toMatchObject({ library: "removed", retryable: true });
	// The new attempt waited for the fenced one, read once and saved.
	for (const hold of holds.slice(2)) hold.resolve();
	media = (id) => new Response(id.startsWith("video") ? video : referencePng);
	now += 5_000;
	runtime.autoSave.start();
	await settle();
	expect((await summary("image"))?.library).toBe("saved");
	expect(await leftovers()).toHaveLength(1);
});

test("a missing file stays unavailable until Download again", async () => {
	runtime = open();
	await runtime.start();
	await complete("image");
	const [file] = await leftovers();
	await rm(join(directory, file));
	expect(await runtime.gallery.list()).toMatchObject([{ jobId: "image", available: false }]);
	runtime.autoSave.start();
	await settle();
	expect(await summary("image")).toMatchObject({ library: "unavailable", retryable: true });
	expect(transfers).toEqual(["image"]);
	now += 5_000;
	expect(await runtime.autoSave.retry("image")).toBe(true);
	await settle();
	expect(await summary("image")).toMatchObject({ library: "saved" });
	expect(transfers).toEqual(["image", "image"]);
});

test("a paused job saves after Refresh with exactly one status read", async () => {
	let paused = true;
	status = (id) => (paused ? new Response(null, { status: 401 }) : finished(id));
	runtime = open();
	await runtime.start();
	await insert("image", "completed");
	await installation.use((db) => db.run(sql`UPDATE image_job SET save_due=0 WHERE id='image'`));
	runtime.autoSave.start();
	await settle();
	expect(await summary("image")).toMatchObject({ library: "paused", tracking: "paused" });
	expect(await job("image")).toMatchObject({ save_due: 0, save_tries: 0, save_attempt: null });
	expect(reads).toEqual(["image"]);
	paused = false;
	now += 60_000;
	await runtime.jobs.refresh("image");
	await settle();
	expect(reads).toEqual(["image", "image"]);
	expect(await summary("image")).toMatchObject({ library: "saved" });
});

test("signed result links never reach the database, logs or summaries", async () => {
	const logged: unknown[] = [];
	const methods = ["log", "info", "warn", "error"] as const;
	const originals = methods.map((name) => console[name]);
	for (const name of methods) console[name] = (...args: unknown[]) => void logged.push(args);
	try {
		runtime = open();
		await runtime.start();
		await complete("image", "video");
		status = (id) => finished(id, null);
		await complete("image-2");
	} finally {
		for (const [index, name] of methods.entries()) console[name] = originals[index];
	}
	const rows = await installation.use((db) => db.all(sql`SELECT * FROM image_job`));
	const text = JSON.stringify([
		rows,
		await runtime.jobs.list(),
		await runtime.jobs.history(),
		logged,
	]);
	expect(text).not.toContain("signed-result-sentinel");
	expect(text).not.toContain(credential);
	for (const name of await readdir(directory))
		if (name.startsWith("studio.db"))
			expect(await Bun.file(join(directory, name)).text()).not.toContain("signed-result-sentinel");
});

test("Retry download refuses a job whose key no longer decrypts", async () => {
	status = (id) => finished(id, null);
	runtime = open();
	await runtime.start();
	await complete("image");
	expect(await summary("image")).toMatchObject({ library: "failed", retryable: true });
	await rm(join(directory, providerKeyFilename));
	expect(await summary("image")).toMatchObject({ library: "failed", retryable: false });
	expect(await runtime.autoSave.retry("image")).toBe(false);
	expect(await job("image")).toMatchObject({ save_hold: "failed" });
});
