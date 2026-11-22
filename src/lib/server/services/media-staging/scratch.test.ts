import { expect, test } from "bun:test";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createOwnerDirectory } from "../../../../../tests/fixtures/owner-directory";
import { openInstallation } from "../../db/installation";
import { openRuntimeInstallation, type RuntimeInstallation } from "../../db/runtime-installation";
import { createScratchPool } from "./scratch";

test("upper-bound reserve, smaller commit", async () => {
	const root = await createOwnerDirectory();
	const installation = await openRuntimeInstallation(root);
	try {
		const pool = createScratchPool(installation, { bytes: 10 });
		await pool.reclaim();
		const image = await pool.scope("image");
		const video = await pool.scope("video");
		expect(image.directory).toBe(join(installation.directory, "scratch", "image"));
		const pending = video.reserve(8);
		expect(() => image.reserve(3)).toThrow("Local scratch full");
		pending.commit(5);
		expect(pool.used).toBe(5);
		const second = image.reserve(5);
		expect(() => pending.commit(6)).toThrow(RangeError);
		second.release();
		second.release();
		pending.release();
		expect(pool.used).toBe(0);
		expect(() => image.reserve(0)).toThrow(RangeError);
		expect(() => image.reserve(11)).toThrow("Local scratch full");
	} finally {
		await installation.close();
		await rm(root, { recursive: true, force: true });
	}
});

test("reclaim needs the lock handle; a contending runtime fails first", async () => {
	const root = await createOwnerDirectory();
	const plain = await openInstallation(root);
	await plain.close();
	await expect(createScratchPool(plain as RuntimeInstallation).reclaim()).rejects.toThrow(
		"runtime installation lock",
	);
	const installation = await openRuntimeInstallation(root);
	try {
		const leftover = join(installation.directory, "scratch", "image");
		await mkdir(leftover, { recursive: true });
		await writeFile(join(leftover, crypto.randomUUID()), "interrupted copy");
		const pool = createScratchPool(installation);
		await expect(pool.scope("image")).rejects.toThrow("Reclaim");
		await pool.reclaim();
		expect(await readdir(join(installation.directory, "scratch"))).toEqual([]);
		const active = await pool.scope("image");
		await writeFile(join(active.directory, "active"), "in use");
		// A second runtime is refused before it can reach reclaim.
		await expect(openRuntimeInstallation(root)).rejects.toThrow("in use");
		const entry = new URL("../../db/runtime-installation.ts", import.meta.url).href;
		const child = Bun.spawn(
			[
				process.execPath,
				"-e",
				`import {openRuntimeInstallation} from ${JSON.stringify(entry)}; try { await openRuntimeInstallation(process.argv[1]); process.exit(2) } catch (error) { process.exit(error.message === "Studio installation is in use." ? 0 : 3) }`,
				root,
			],
			{ stdout: "ignore", stderr: "ignore" },
		);
		expect(await child.exited).toBe(0);
		expect(await readdir(active.directory)).toEqual(["active"]);
	} finally {
		await installation.close();
		await rm(root, { recursive: true, force: true });
	}
});
