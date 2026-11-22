import { expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { sql } from "drizzle-orm";
import { createOwnerDirectory } from "../../../../../tests/fixtures/owner-directory";
import {
	box,
	h264Aac,
	payload,
	replaceBox,
	rewrite,
	setField,
} from "../../../../../tests/fixtures/video/mp4-boxes";
import { providerStore } from "../../db/provider-store";
import { openRuntimeInstallation, type RuntimeInstallation } from "../../db/runtime-installation";
import { createJobTracking } from "../jobs/tracking";
import { downloadVideo } from "../video-media/download";
import { createGallery } from "./gallery";

const sample = h264Aac();
const digest = createHash("sha256").update(sample).digest("hex");
const delivery = async () => ({ url: "https://93.184.216.34/video", fallback: null });
const scratchFiles = async (directory: string) =>
	(await readdir(directory)).filter((p) => p.endsWith(".part"));

async function withRuntime(work: (db: RuntimeInstallation, directory: string) => Promise<void>) {
	const directory = await createOwnerDirectory();
	const db = await openRuntimeInstallation(directory);
	try {
		await work(db, directory);
	} finally {
		await db.close();
		await rm(directory, { recursive: true, force: true });
	}
}

test("a second save waits, then saves", () =>
	withRuntime(async (db, directory) => {
		const transfers: string[] = [];
		const entered = Promise.withResolvers<void>();
		const finish = Promise.withResolvers<void>();
		const gallery = createGallery(
			db,
			async () => null,
			undefined,
			async (source, path) => {
				transfers.push(source.url);
				await writeFile(path, sample, { flag: "wx", mode: 0o600 });
				if (source.url.endsWith("/one")) {
					entered.resolve();
					await finish.promise;
				}
				return { size: sample.length, digest };
			},
		);
		const from = (name: string) => async () => ({
			url: `https://93.184.216.34/${name}`,
			fallback: null,
		});
		try {
			const first = gallery.saveVideo("one", from("one"));
			await entered.promise;
			const joined = gallery.saveVideo("one", from("one"));
			let secondDone = false;
			const second = gallery.saveVideo("two", from("two")).finally(() => {
				secondDone = true;
			});
			await Bun.sleep(50);
			expect(secondDone).toBe(false);
			expect(await scratchFiles(directory)).toHaveLength(1);
			finish.resolve();
			const saved = "Saved to Gallery.";
			expect(await Promise.all([first, joined, second])).toEqual([saved, saved, saved]);
			expect(transfers).toEqual(["https://93.184.216.34/one", "https://93.184.216.34/two"]);
			const video = await gallery.openVideo("two");
			try {
				expect(await video?.handle.readFile()).toEqual(sample);
			} finally {
				await video?.handle.close();
			}
			expect(await scratchFiles(directory)).toBeEmpty();

			// Remove during a transfer cancels publication; a failed write leaves no scratch.
			const replacing = Promise.withResolvers<void>();
			const resume = Promise.withResolvers<void>();
			const repair = gallery.saveVideo("three", async () => {
				replacing.resolve();
				await resume.promise;
				return delivery();
			});
			await replacing.promise;
			await gallery.remove("three");
			resume.resolve();
			expect(await repair).toContain("could not be saved");
			expect(await gallery.get("three")).toBeNull();
			const failing = createGallery(
				db,
				async () => null,
				undefined,
				async (_source, path) => {
					await copyFile("tests/fixtures/video/h264-aac.mp4", path);
					throw Object.assign(new Error("Fixture write refused"), { code: "ENOSPC" });
				},
			);
			expect(await failing.saveVideo("four", delivery)).toContain("write failed");
			expect(await gallery.get("four")).toBeNull();
			expect(await scratchFiles(directory)).toBeEmpty();
		} finally {
			finish.resolve();
		}
	}));

test("Remove cancels a Save that is waiting for the slot", () =>
	withRuntime(async (db) => {
		const transfers: string[] = [];
		const asked: string[] = [];
		const entered = Promise.withResolvers<void>();
		const finish = Promise.withResolvers<void>();
		const gallery = createGallery(
			db,
			async () => null,
			undefined,
			async (source, path) => {
				transfers.push(source.url);
				await writeFile(path, sample, { flag: "wx", mode: 0o600 });
				if (source.url.endsWith("/a")) {
					entered.resolve();
					await finish.promise;
				}
				return { size: sample.length, digest };
			},
		);
		const from = (name: string) => async () => {
			asked.push(name);
			return { url: `https://93.184.216.34/${name}`, fallback: null };
		};
		try {
			const first = gallery.saveVideo("a", from("a"));
			await entered.promise;
			const queued = gallery.saveVideo("x", from("x"));
			await Bun.sleep(20);
			await gallery.remove("x");
			finish.resolve();
			expect(await first).toBe("Saved to Gallery.");
			expect(await queued).toBe("The video could not be saved.");
			expect(await gallery.get("x")).toBeNull();
			expect(asked).toEqual(["a"]);
			expect(transfers).toEqual(["https://93.184.216.34/a"]);
		} finally {
			finish.resolve();
		}
	}));

test("a Save after Remove cancels the waiting one starts afresh", () =>
	withRuntime(async (db) => {
		const transfers: string[] = [];
		const entered = Promise.withResolvers<void>();
		const finish = Promise.withResolvers<void>();
		const gallery = createGallery(
			db,
			async () => null,
			undefined,
			async (source, path) => {
				transfers.push(source.url);
				await writeFile(path, sample, { flag: "wx", mode: 0o600 });
				if (source.url.endsWith("/a")) {
					entered.resolve();
					await finish.promise;
				}
				return { size: sample.length, digest };
			},
		);
		const from = (name: string) => async () => ({
			url: `https://93.184.216.34/${name}`,
			fallback: null,
		});
		try {
			const first = gallery.saveVideo("a", from("a"));
			await entered.promise;
			const cancelled = gallery.saveVideo("x", from("x"));
			await Bun.sleep(20);
			await gallery.remove("x");
			const again = gallery.saveVideo("x", from("x"));
			finish.resolve();
			expect(await first).toBe("Saved to Gallery.");
			expect(await cancelled).toBe("The video could not be saved.");
			expect(await again).toBe("Saved to Gallery.");
			expect((await gallery.get("x"))?.available).toBe(true);
			expect(transfers).toEqual(["https://93.184.216.34/a", "https://93.184.216.34/x"]);
		} finally {
			finish.resolve();
		}
	}));

test("startup removes leftover scratch and finishes interrupted removal", () =>
	withRuntime(async (db, directory) => {
		const gallery = createGallery(
			db,
			async () => null,
			undefined,
			async (_source, path) => {
				await writeFile(path, sample, { flag: "wx", mode: 0o600 });
				return { size: sample.length, digest };
			},
		);
		expect(await gallery.saveVideo("one", delivery)).toBe("Saved to Gallery.");
		const leftover = `video-${crypto.randomUUID()}.part`;
		const stuck = `video-${crypto.randomUUID()}.part`;
		await writeFile(join(directory, leftover), "incomplete");
		await mkdir(join(directory, stuck, "child"), { recursive: true });
		await db.use(async (c) => {
			await c.run(sql`UPDATE gallery_image SET state='deleting' WHERE job_id='one'`);
			await c.run(
				sql`INSERT INTO video_save(singleton,job_id,token,pid,runtime) VALUES(1,'interrupted',${crypto.randomUUID()},1,'previous-runtime')`,
			);
		});
		const logged = spyOn(console, "error").mockImplementation(() => {});
		try {
			await gallery.recover();
			expect(logged.mock.calls).toEqual([[`Unable to remove leftover video scratch ${stuck}.`]]);
		} finally {
			logged.mockRestore();
		}
		expect(await gallery.list()).toBeEmpty();
		expect(await db.use((c) => c.all(sql`SELECT * FROM video_save`))).toBeEmpty();
		expect(
			(await readdir(directory)).filter((p) => p.startsWith("gallery-") || p.endsWith(".part")),
		).toEqual([stuck]);
	}));

test("a scratch file that cannot be removed does not block the next Save", () =>
	withRuntime(async (db, directory) => {
		let stuck = "";
		const gallery = createGallery(
			db,
			async () => null,
			undefined,
			async (source, path) => {
				if (source.url.endsWith("/stuck")) {
					// A directory at the scratch path makes the non-recursive unlink fail.
					stuck = basename(path);
					await mkdir(join(path, "child"), { recursive: true });
					throw new Error("Fixture transfer failed");
				}
				await writeFile(path, sample, { flag: "wx", mode: 0o600 });
				return { size: sample.length, digest };
			},
		);
		const logged = spyOn(console, "error").mockImplementation(() => {});
		try {
			const stuckDelivery = async () => ({ url: "https://93.184.216.34/stuck", fallback: null });
			expect(await gallery.saveVideo("one", stuckDelivery)).toContain("write failed");
			expect(logged.mock.calls).toEqual([[`Unable to remove leftover video scratch ${stuck}.`]]);
		} finally {
			logged.mockRestore();
		}
		expect(await db.use((c) => c.all(sql`SELECT * FROM video_save`))).toBeEmpty();
		expect(await gallery.saveVideo("two", delivery)).toBe("Saved to Gallery.");
		expect(await scratchFiles(directory)).toEqual([stuck]);
	}));

test("a second runtime on the same directory is refused", () =>
	withRuntime(async (_db, directory) => {
		await expect(openRuntimeInstallation(directory)).rejects.toThrow(
			"Studio installation is in use.",
		);
	}));

async function withGallery(
	respond: () => Response,
	work: (gallery: ReturnType<typeof createGallery>, directory: string) => Promise<void>,
) {
	const directory = await createOwnerDirectory();
	const db = await openRuntimeInstallation(directory);
	const transport = { resolve: async () => "93.184.216.34", request: async () => respond() };
	try {
		await work(
			createGallery(
				db,
				async () => null,
				undefined,
				(source, path) => downloadVideo(source, path, transport),
			),
			directory,
		);
	} finally {
		await db.close();
		await rm(directory, { recursive: true, force: true });
	}
}
test("a short transfer is a failed download, with or without Content-Length", async () => {
	const bytes = h264Aac();
	const short = bytes.subarray(0, bytes.length - 100);
	for (const headers of [{ "content-length": String(bytes.length) }, {}] as Record<
		string,
		string
	>[])
		await withGallery(
			() => new Response(short, { headers }),
			async (gallery, directory) => {
				expect(await gallery.saveVideo("short", delivery)).toBe(
					"The video download or local write failed. Retry Save on this job.",
				);
				expect(await gallery.get("short")).toBeNull();
				expect((await readdir(directory)).filter((p) => p.endsWith(".part"))).toBeEmpty();
			},
		);
});

test("a complete clip saves without native tools and refusals name the profile or WebM", async () => {
	const bytes = h264Aac();
	await withGallery(
		() => new Response(bytes),
		async (gallery) => {
			expect(await gallery.saveVideo("clip", delivery)).toBe("Saved to Gallery.");
			expect(await gallery.get("clip")).toMatchObject({ duration: 2, width: 96, height: 64 });
		},
	);
	const outside = setField(bytes, "moov/trak/mdia/minf/stbl/stco", 8, 0);
	await withGallery(
		() => new Response(outside),
		async (gallery) => {
			expect(await gallery.saveVideo("outside", delivery)).toBe(
				"This completed video is outside the supported Gallery profile.",
			);
		},
	);
	const webm = Buffer.concat([Buffer.from("1a45dfa38b42868101428284", "hex"), Buffer.from("webm")]);
	await withGallery(
		() => new Response(Buffer.concat([webm, Buffer.alloc(32)])),
		async (gallery) => {
			expect(await gallery.saveVideo("webm", delivery)).toBe(
				"This completed video is WebM or Matroska. Gallery keeps MP4 files only.",
			);
		},
	);
});

test("a video over 64 MiB, declared or observed, gets the profile message", async () => {
	const chunk = new Uint8Array(1024 * 1024);
	const oversized = () => {
		let sent = 0;
		return new ReadableStream<Uint8Array>({
			pull(controller) {
				if (sent++ > 64) controller.close();
				else controller.enqueue(chunk);
			},
		});
	};
	for (const respond of [
		() => new Response("large", { headers: { "content-length": String(64 * 1024 * 1024 + 1) } }),
		() => new Response(oversized()),
	])
		await withGallery(respond, async (gallery, directory) => {
			expect(await gallery.saveVideo("large", delivery)).toBe(
				"This completed video is outside the supported Gallery profile.",
			);
			expect(await gallery.get("large")).toBeNull();
			expect(await scratchFiles(directory)).toBeEmpty();
		});
});

/** h264Aac rewritten to a clip Gallery refuses, named after what makes it ineligible. */
function outsideProfile() {
	const source = h264Aac();
	const avc1 = "moov/trak#0/mdia/minf/stbl/stsd/avc1";
	// Thirteen presented seconds with a matching mvhd (the stts row is 24 samples of 6,656).
	let long = setField(source, "moov/trak#0/mdia/mdhd", 16, 13 * 12288);
	long = rewrite(long, "moov/trak#0/mdia/minf/stbl/stts", () => {
		const row = Buffer.alloc(16);
		row.writeUInt32BE(1, 4);
		row.writeUInt32BE(24, 8);
		row.writeUInt32BE((13 * 12288) / 24, 12);
		return row;
	});
	long = setField(long, "moov/trak#0/edts/elst", 8, 13 * 48000);
	long = setField(long, "moov/mvhd", 16, 13 * 48000);
	const mov = rewrite(source, "ftyp", (data) =>
		Buffer.concat([Buffer.from("qt  "), data.subarray(4)]),
	);
	return {
		hevc: replaceBox(source, avc1, box("hvc1", payload(source, avc1))),
		"2520x1080": setField(setField(source, avc1, 24, 2520, 2), avc1, 26, 1080, 2),
		"13 s": long,
		mov,
	};
}

test("Poyo single video saves through the structural verifier", async () => {
	const directory = await createOwnerDirectory();
	let db = await openRuntimeInstallation(directory);
	let now = Date.parse("2026-11-22T00:00:00Z");
	const clip = "https://93.184.216.34/h3.mp4";
	let tracking: ReturnType<typeof createJobTracking> | undefined;
	try {
		await providerStore(db).save("poyo", "balance-only", now, false, 0);
		tracking = createJobTracking(db, providerStore(db), {
			now: () => now,
			random: () => 0,
			fetch: async (url, init) => {
				if (url.endsWith("/api/user/balance"))
					return Response.json({ code: 200, data: { credits_amount: 100 } });
				if (init.method === "POST") {
					const id = JSON.parse(String(init.body)).input.prompt;
					return Response.json({ code: 200, data: { task_id: id } });
				}
				return Response.json({
					code: 200,
					data: {
						task_id: url.split("/").at(-1),
						status: "finished",
						credits_amount: 80,
						files: [{ file_type: "video", file_url: clip }],
					},
				});
			},
		});
		const jobs = tracking;
		for (const id of ["silent", "audio"]) {
			await db.use((c) =>
				c.run(sql`INSERT INTO image_job (id,binding,provider,revision,quote,state,created_at,model,operation,poll_deadline,video_terms)
					VALUES (${id},'binding','poyo',1,'{}','submitting',${now},'h3-max','text-to-video',${now + 120_000},'[]')`),
			);
			await jobs.dispatchVideo(id, "balance-only", {
				provider: "poyo",
				body: {
					model: "h3-max",
					input: {
						prompt: id,
						duration: 5,
						resolution: "768p",
						aspect_ratio: "16:9",
						enable_safety_checker: false,
					},
				},
			});
		}
		now += 2_000;
		for (const id of ["silent", "audio"]) await jobs.refresh(id);
		let body: Buffer = h264Aac();
		const gallery = createGallery(
			db,
			async () => null,
			undefined,
			(source, path) => {
				expect(source).toEqual({ url: clip, fallback: null });
				return downloadVideo(source, path, {
					resolve: async () => "93.184.216.34",
					request: async () => new Response(new Uint8Array(body)),
				});
			},
		);
		const save = async (id: string, bytes: Buffer) => {
			body = bytes;
			now += 10_000;
			return gallery.saveVideo(id, () => jobs.videoResult(id));
		};
		const profile = "This completed video is outside the supported Gallery profile.";
		const webm = Buffer.from("1a45dfa38b42868101428284", "hex");
		const truncated = h264Aac().subarray(0, h264Aac().length - 64);
		const refusals: [string, Buffer, string][] = [
			...Object.entries(outsideProfile()).map(
				([name, bytes]) => [name, bytes, profile] as [string, Buffer, string],
			),
			[
				"webm",
				Buffer.concat([webm, Buffer.from("webm"), Buffer.alloc(32)]),
				"This completed video is WebM or Matroska. Gallery keeps MP4 files only.",
			],
			[
				"truncated final sample",
				truncated,
				"The video download or local write failed. Retry Save on this job.",
			],
		];
		for (const [name, bytes, message] of refusals) {
			expect(await save("silent", bytes), name).toBe(message);
			expect(
				(await jobs.list()).find((job) => job.id === "silent"),
				name,
			).toMatchObject({
				state: "completed",
				canSave: true,
				billing: { status: "reported", credits: "80" },
			});
		}
		expect(await gallery.get("silent")).toBeNull();
		const silent = await readFile("tests/fixtures/video/silent.mp4");
		expect(await save("silent", silent)).toBe("Saved to Gallery.");
		expect(await save("audio", h264Aac())).toBe("Saved to Gallery.");
		jobs.close();
		await db.close();
		db = await openRuntimeInstallation(directory);
		const reopened = createGallery(db, async () => null);
		await reopened.recover();
		const video = await reopened.openVideo("silent");
		if (!video) throw new Error("Expected the saved H3 clip to reopen.");
		try {
			expect(await video.handle.readFile()).toEqual(silent);
		} finally {
			await video.handle.close();
		}
		await reopened.remove("audio");
		expect(await reopened.get("audio")).toBeNull();
	} finally {
		tracking?.close();
		await db.close();
		await rm(directory, { recursive: true, force: true });
	}
});
