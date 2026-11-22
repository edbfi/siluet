import { rm } from "node:fs/promises";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import type { Installation } from "../../db/installation";
import { runtimeIdentity } from "./runtime-identity";

export function videoSaveSlot({ directory, use }: Installation) {
	const scratch = (token: string) => {
		if (!/^[a-f0-9-]{36}$/.test(token)) throw new Error("Invalid scratch identifier.");
		return join(directory, `video-${token}.part`);
	};
	async function reserve(id?: string) {
		return use((db) =>
			db.transaction(
				async (tx) => {
					const slot = await tx.get<{
						job_id: string;
						token: string;
						pid: number;
						runtime: string;
					}>(sql`SELECT * FROM video_save`);
					if (slot) {
						const owner = await runtimeIdentity(slot.pid);
						if (owner === undefined || owner === slot.runtime)
							return id && slot.job_id === id ? { kind: "join" as const, token: slot.token } : null;
						await rm(scratch(slot.token), { force: true });
						await tx.run(sql`DELETE FROM video_save WHERE singleton=1`);
					}
					if (!id) return null;
					const token = crypto.randomUUID();
					const current = await runtimeIdentity(process.pid);
					if (!current) throw new Error("Video verifier unavailable.");
					await tx.run(
						sql`INSERT INTO video_save(singleton,job_id,token,pid,runtime) VALUES(1,${id},${token},${process.pid},${current})`,
					);
					return { kind: "claimed" as const, path: scratch(token), token };
				},
				{ behavior: "immediate" },
			),
		);
	}
	return {
		reserve,
		async waitForSave(token: string) {
			const deadline = performance.now() + 130_000;
			while (performance.now() < deadline) {
				const active = await use((db) =>
					db.get<{ pid: number; runtime: string }>(
						sql`SELECT pid,runtime FROM video_save WHERE token=${token}`,
					),
				);
				if (!active || (await runtimeIdentity(active.pid)) !== active.runtime) return;
				await Bun.sleep(200);
			}
		},
		async release(token: string) {
			await rm(scratch(token), { force: true });
			await use((db) => db.run(sql`DELETE FROM video_save WHERE token=${token}`));
		},
	};
}
