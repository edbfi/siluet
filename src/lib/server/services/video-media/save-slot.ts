import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import type { RuntimeInstallation } from "../../db/runtime-installation";

const scratchName = /^video-[a-f0-9-]{36}\.part$/;
/** Log only the scratch file name; the next startup retries it. */
const unremoved = (name: string) =>
	console.error(`Unable to remove leftover video scratch ${name}.`);

/**
 * One video Save at a time in the single runtime that holds the installation.
 * The `video_save` row names the active scratch file and lets Remove cancel
 * publication; no other process can own it.
 */
export function videoSaveSlot({ directory, use }: RuntimeInstallation) {
	let turn = Promise.resolve();
	const fileName = (token: string) => `video-${token}.part`;
	const scratch = (token: string) => join(directory, fileName(token));
	/** Wait for the slot, then run `work` while holding it. */
	async function exclusive<T>(work: () => Promise<T>) {
		const previous = turn;
		const done = Promise.withResolvers<void>();
		turn = done.promise;
		await previous;
		try {
			return await work();
		} finally {
			done.resolve();
		}
	}
	return {
		/** Hold the slot for job `id` while `work` writes to the scratch path. */
		hold<T>(id: string, work: (slot: { path: string; token: string }) => Promise<T>) {
			return exclusive(async () => {
				const token = crypto.randomUUID();
				await use((db) =>
					db.run(
						sql`INSERT INTO video_save(singleton,job_id,token,pid,runtime) VALUES(1,${id},${token},${process.pid},'')`,
					),
				);
				try {
					return await work({ path: scratch(token), token });
				} finally {
					await rm(scratch(token), { force: true }).catch(() => unremoved(fileName(token)));
					await use((db) => db.run(sql`DELETE FROM video_save WHERE token=${token}`));
				}
			});
		},
		/** Remove every leftover scratch file and slot row from an earlier run. */
		recover() {
			return exclusive(async () => {
				await use((db) => db.run(sql`DELETE FROM video_save`));
				for (const name of await readdir(directory)) {
					if (!scratchName.test(name)) continue;
					await rm(join(directory, name), { force: true }).catch(() => unremoved(name));
				}
			});
		},
	};
}
