import { expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
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
import { downloadVideo, type VideoDelivery } from "../video-media/download";
import { createAutoSave } from "./auto-save";
import { createGallery } from "./gallery";

const sample = h264Aac();
const digest = createHash("sha256").update(sample).digest("hex");
const host = "https://93.184.216.34";
const scratchFiles = async (directory: string) =>
	(await readdir(directory)).filter((p) => p.endsWith(".part"));

type Transfer = NonNullable<Parameters<typeof createAutoSave>[1]["transferVideo"]>;
/** A runtime whose completed video jobs are pending, with deliveries from the fixture host. */
async function withRuntime(
	work: (saver: {
		db: RuntimeInstallation;
		directory: string;
		gallery: ReturnType<typeof createGallery>;
		autoSave: ReturnType<typeof createAutoSave>;
		queue: (...ids: string[]) => Promise<void>;
		hold: (id: string) => Promise<string | null>;
		idle: () => Promise<void>;
	}) => Promise<void>,
	transferVideo: Transfer = async (_source, path) => {
		await writeFile(path, sample, { flag: "wx", mode: 0o600 });
		return { size: sample.length, digest };
	},
) {
	const directory = await createOwnerDirectory();
	const db = await openRuntimeInstallation(directory);
	await providerStore(db).save("poyo", "fixture-key", Date.now(), false, 0);
	const autoSave = createAutoSave(db, {
		readForSave: async (id) => ({
			kind: "delivered",
			delivery: { url: `${host}/${id}`, fallback: null } satisfies VideoDelivery,
		}),
		readability: async () => () => true,
		transferVideo,
	});
	const gallery = createGallery(db);
	const idle = async () => {
		await Bun.sleep(5);
		await autoSave.idle();
	};
	try {
		autoSave.start();
		await work({
			db,
			directory,
			gallery,
			autoSave,
			async queue(...ids) {
				for (const id of ids)
					await db.use((c) =>
						c.run(sql`INSERT INTO image_job
							(id,binding,provider,revision,quote,state,model,created_at,poll_deadline,video_terms,save_due)
							VALUES (${id},${id},'poyo',1,'{}','completed','h3-max',0,120000,'[]',0)`),
					);
				autoSave.start();
			},
			async hold(id) {
				const row = await db.use((c) =>
					c.get<{ save_hold: string | null }>(sql`SELECT save_hold FROM image_job WHERE id=${id}`),
				);
				return row?.save_hold ?? null;
			},
			idle,
		});
	} finally {
		await autoSave.close();
		await db.close();
		await rm(directory, { recursive: true, force: true });
	}
}

test("a second save waits, then saves", async () => {
	const transfers: string[] = [];
	const entered = Promise.withResolvers<void>();
	const finish = Promise.withResolvers<void>();
	await withRuntime(
		async ({ directory, gallery, queue, idle }) => {
			try {
				await queue("one");
				await entered.promise;
				await queue("two");
				await Bun.sleep(50);
				expect(transfers).toEqual([`${host}/one`]);
				expect(await scratchFiles(directory)).toHaveLength(1);
				finish.resolve();
				await idle();
				expect(transfers).toEqual([`${host}/one`, `${host}/two`]);
				const video = await gallery.openVideo("two");
				try {
					expect(await video?.handle.readFile()).toEqual(sample);
				} finally {
					await video?.handle.close();
				}
				expect(await scratchFiles(directory)).toBeEmpty();
			} finally {
				finish.resolve();
			}
		},
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
});

test("Remove holds a waiting video, and Download again saves it afresh", async () => {
	const transfers: string[] = [];
	const entered = Promise.withResolvers<void>();
	const finish = Promise.withResolvers<void>();
	await withRuntime(
		async ({ db, gallery, autoSave, queue, hold, idle }) => {
			try {
				await queue("a");
				await entered.promise;
				await queue("x");
				await gallery.remove("x");
				finish.resolve();
				await idle();
				expect(transfers).toEqual([`${host}/a`]);
				expect(await gallery.get("x")).toBeNull();
				expect(await hold("x")).toBe("removed");
				// A failed write leaves no scratch either.
				expect(await autoSave.retry("x")).toBe(true);
				await idle();
				expect((await gallery.get("x"))?.available).toBe(true);
				expect(transfers).toEqual([`${host}/a`, `${host}/x`]);
				expect(
					await db.use((c) => c.all(sql`SELECT name FROM sqlite_schema WHERE name='video_save'`)),
				).toEqual([]);
			} finally {
				finish.resolve();
			}
		},
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
});

test("startup removes leftover scratch and finishes interrupted removal", () =>
	withRuntime(async ({ db, directory, gallery, queue, idle }) => {
		await queue("one");
		await idle();
		const leftover = `video-${crypto.randomUUID()}.part`;
		const stuck = `video-${crypto.randomUUID()}.part`;
		await writeFile(join(directory, leftover), "incomplete");
		await mkdir(join(directory, stuck, "child"), { recursive: true });
		await db.use((c) => c.run(sql`UPDATE gallery_image SET state='deleting' WHERE job_id='one'`));
		const logged = spyOn(console, "error").mockImplementation(() => {});
		try {
			await gallery.recover();
			expect(logged.mock.calls).toEqual([[`Unable to remove leftover video scratch ${stuck}.`]]);
		} finally {
			logged.mockRestore();
		}
		expect(await gallery.list()).toBeEmpty();
		expect(
			(await readdir(directory)).filter((p) => p.startsWith("gallery-") || p.endsWith(".part")),
		).toEqual([stuck]);
	}));

test("a scratch file that cannot be removed does not block the next Save", async () => {
	let stuck = "";
	const logged = spyOn(console, "error").mockImplementation(() => {});
	try {
		await withRuntime(
			async ({ directory, gallery, queue, idle }) => {
				await queue("stuck");
				await idle();
				expect(logged.mock.calls).toEqual([[`Unable to remove leftover video scratch ${stuck}.`]]);
				await queue("two");
				await idle();
				expect((await gallery.get("two"))?.available).toBe(true);
				expect(await scratchFiles(directory)).toEqual([stuck]);
			},
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
	} finally {
		logged.mockRestore();
	}
});

test("a second runtime on the same directory is refused", () =>
	withRuntime(async ({ directory }) => {
		await expect(openRuntimeInstallation(directory)).rejects.toThrow(
			"Studio installation is in use.",
		);
	}));

const fromBody =
	(respond: () => Response): Transfer =>
	(source, path, _transport, signal) =>
		downloadVideo(
			source,
			path,
			{ resolve: async () => "93.184.216.34", request: async () => respond() },
			signal,
		);

test("a short transfer is a failed download, with or without Content-Length", async () => {
	const short = sample.subarray(0, sample.length - 100);
	for (const headers of [{ "content-length": String(sample.length) }, {}] as Record<
		string,
		string
	>[])
		await withRuntime(
			async ({ db, directory, gallery, queue, hold, idle }) => {
				await queue("short");
				await idle();
				expect(await gallery.get("short")).toBeNull();
				expect(await hold("short")).toBeNull();
				expect(
					await db.use((c) => c.get(sql`SELECT save_tries FROM image_job WHERE id='short'`)),
				).toEqual({ save_tries: 1 });
				expect(await scratchFiles(directory)).toBeEmpty();
			},
			fromBody(() => new Response(short, { headers })),
		);
});

test("a complete clip saves without native tools and refusals hold the profile or WebM", async () => {
	await withRuntime(
		async ({ gallery, queue, idle }) => {
			await queue("clip");
			await idle();
			expect(await gallery.get("clip")).toMatchObject({ duration: 2, width: 96, height: 64 });
		},
		fromBody(() => new Response(sample)),
	);
	const outside = setField(sample, "moov/trak/mdia/minf/stbl/stco", 8, 0);
	await withRuntime(
		async ({ queue, hold, idle }) => {
			await queue("outside");
			await idle();
			expect(await hold("outside")).toBe("unsupported");
		},
		fromBody(() => new Response(outside)),
	);
	const webm = Buffer.concat([Buffer.from("1a45dfa38b42868101428284", "hex"), Buffer.from("webm")]);
	await withRuntime(
		async ({ queue, hold, idle }) => {
			await queue("webm");
			await idle();
			expect(await hold("webm")).toBe("webm");
		},
		fromBody(() => new Response(Buffer.concat([webm, Buffer.alloc(32)]))),
	);
});

test("a video over 64 MiB, declared or observed, is held outside the profile", async () => {
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
		await withRuntime(async ({ directory, gallery, queue, hold, idle }) => {
			await queue("large");
			await idle();
			expect(await hold("large")).toBe("unsupported");
			expect(await gallery.get("large")).toBeNull();
			expect(await scratchFiles(directory)).toBeEmpty();
		}, fromBody(respond));
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

test("Poyo single video saves automatically through the structural verifier", async () => {
	const directory = await createOwnerDirectory();
	let db = await openRuntimeInstallation(directory);
	let now = Date.parse("2026-11-22T00:00:00Z");
	const clip = "https://93.184.216.34/h3.mp4";
	let body: Buffer = h264Aac();
	let tracking: ReturnType<typeof createJobTracking> | undefined;
	let autoSave: ReturnType<typeof createAutoSave> | undefined;
	const idle = async () => {
		await Bun.sleep(5);
		await autoSave?.idle();
	};
	try {
		await providerStore(db).save("poyo", "balance-only", now, false, 0);
		const jobs = createJobTracking(db, providerStore(db), {
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
			onDelivery: (id, delivery) => autoSave?.deliver(id, delivery),
		});
		tracking = jobs;
		const saver = createAutoSave(db, {
			readForSave: jobs.readForSave,
			readability: providerStore(db).jobReadability,
			now: () => now,
			transferVideo: (source, path, _transport, signal) => {
				expect(source).toEqual({ url: clip, fallback: null });
				return downloadVideo(
					source,
					path,
					{
						resolve: async () => "93.184.216.34",
						request: async () => new Response(new Uint8Array(body)),
					},
					signal,
				);
			},
		});
		autoSave = saver;
		saver.start();
		const profile = Object.keys(outsideProfile());
		const refusals = [...profile, "webm", "truncated final sample", "silent", "audio"];
		const bodies: Record<string, Buffer> = {
			...outsideProfile(),
			webm: Buffer.concat([
				Buffer.from("1a45dfa38b42868101428284", "hex"),
				Buffer.from("webm"),
				Buffer.alloc(32),
			]),
			"truncated final sample": h264Aac().subarray(0, h264Aac().length - 64),
			silent: await readFile("tests/fixtures/video/silent.mp4"),
			audio: h264Aac(),
		};
		const holds: Record<string, string | null> = {};
		for (const name of refusals) {
			// Poyo task IDs carry no spaces.
			const id = name.replace(/\W+/g, "-");
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
			now += 2_000;
			body = bodies[name];
			await jobs.refresh(id);
			await idle();
			const row = await db.use((c) =>
				c.get<{ save_hold: string | null; save_tries: number }>(
					sql`SELECT save_hold, save_tries FROM image_job WHERE id=${id}`,
				),
			);
			holds[name] = row?.save_hold ?? (row?.save_tries ? `tries ${row.save_tries}` : null);
			expect(
				(await jobs.list()).find((job) => job.id === id),
				id,
			).toMatchObject({
				state: "completed",
				billing: { status: "reported", credits: "80" },
			});
		}
		expect(holds).toEqual({
			...Object.fromEntries(profile.map((name) => [name, "unsupported"])),
			webm: "webm",
			"truncated final sample": "tries 1",
			silent: null,
			audio: null,
		});
		jobs.close();
		await saver.close();
		await db.close();
		db = await openRuntimeInstallation(directory);
		const reopened = createGallery(db);
		await reopened.recover();
		const video = await reopened.openVideo("silent");
		if (!video) throw new Error("Expected the saved H3 clip to reopen.");
		try {
			expect((await video.handle.readFile()).equals(bodies.silent)).toBe(true);
		} finally {
			await video.handle.close();
		}
		await reopened.remove("audio");
		expect(await reopened.get("audio")).toBeNull();
	} finally {
		tracking?.close();
		await autoSave?.close();
		await db.close();
		await rm(directory, { recursive: true, force: true });
	}
});
