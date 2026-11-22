import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { copyFile, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { createOwnerDirectory } from "../../../../../tests/fixtures/owner-directory";
import { openInstallation } from "../../db/installation";
import { createGallery } from "./gallery";

test.skipIf(!process.env.SILUET_FFMPEG_DIR)(
	"two installations join the same Save, protect active scratch, and recover interrupted writes and removal",
	async () => {
		const directory = await createOwnerDirectory();
		const db = await openInstallation(directory);
		const second = await openInstallation(directory);
		let count = 0,
			failWrite = false;
		const entered = Promise.withResolvers<void>(),
			finish = Promise.withResolvers<void>();
		const sample = "tests/fixtures/video/silent.mp4";
		const bytes = await readFile(sample);
		const transfer = async (_source: unknown, path: string) => {
			count++;
			await copyFile(sample, path);
			if (failWrite) throw Object.assign(new Error("Fixture write refused"), { code: "ENOSPC" });
			entered.resolve();
			await finish.promise;
			return { size: bytes.length, digest: createHash("sha256").update(bytes).digest("hex") };
		};
		const gallery = createGallery(db, async () => null, undefined, transfer);
		const other = createGallery(second, async () => null, undefined, transfer);
		const result = async () => ({ url: "https://fixture.example/video", fallback: null });
		try {
			const save = gallery.saveVideo("one", result);
			await entered.promise;
			await other.recover();
			expect((await readdir(directory)).filter((p) => p.endsWith(".part"))).toHaveLength(1);
			const joined = other.saveVideo("one", result);
			expect(await other.saveVideo("two", result)).toContain("Another video Save");
			expect(await gallery.list()).toEqual([]);
			finish.resolve();
			expect(await Promise.all([save, joined])).toEqual(["Saved to Gallery.", "Saved to Gallery."]);
			expect(count).toBe(1);
			const video = await gallery.openVideo("one");
			expect(video).not.toBeNull();
			if (video) {
				try {
					expect(await video.handle.readFile()).toEqual(bytes);
				} finally {
					await video.handle.close();
				}
			}
			const replacing = Promise.withResolvers<void>();
			const resume = Promise.withResolvers<void>();
			const repair = other.saveVideo("three", async () => {
				replacing.resolve();
				await resume.promise;
				return result();
			});
			await replacing.promise;
			await gallery.remove("three");
			resume.resolve();
			expect(await repair).toContain("could not be saved");
			expect(await gallery.get("three")).toBeNull();
			failWrite = true;
			expect(await gallery.saveVideo("two", result)).toContain("write failed");
			expect(await gallery.get("two")).toBeNull();
			expect((await readdir(directory)).filter((p) => p.endsWith(".part"))).toBeEmpty();
			// Crash after durable removal intent, and an abandoned transfer owned by a prior runtime.
			const token = crypto.randomUUID();
			await writeFile(join(directory, `video-${token}.part`), "incomplete");
			await db.use(async (c) => {
				await c.run(sql`UPDATE gallery_image SET state='deleting' WHERE job_id='one'`);
				await c.run(
					sql`INSERT INTO video_save(singleton,job_id,token,pid,runtime) VALUES(1,'interrupted',${token},${process.pid},'previous-runtime')`,
				);
			});
			await other.recover();
			expect(await other.list()).toBeEmpty();
			expect(
				(await readdir(directory)).filter((p) => p.startsWith("gallery-") || p.endsWith(".part")),
			).toBeEmpty();
		} finally {
			finish.resolve();
			await db.close();
			await second.close();
			await rm(directory, { recursive: true, force: true });
		}
	},
	20_000,
);
