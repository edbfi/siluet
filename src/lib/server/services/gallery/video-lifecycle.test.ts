import { expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { createOwnerDirectory } from "../../../../../tests/fixtures/owner-directory";
import { h264Aac, setField } from "../../../../../tests/fixtures/video/mp4-boxes";
import { openRuntimeInstallation, type RuntimeInstallation } from "../../db/runtime-installation";
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
