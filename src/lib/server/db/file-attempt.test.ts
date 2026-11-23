import { expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { sql } from "drizzle-orm";
import { createOwnerDirectory } from "../../../../tests/fixtures/owner-directory";
import { fileAttemptStore } from "./file-attempt";
import { imageJobStore, skipImageSend } from "./image-job-store";
import { openInstallation } from "./installation";
import { openRuntimeInstallation } from "./runtime-installation";

test("recovery distinguishes both dispatch boundaries and preserves unresolved wallets", async () => {
	const root = await createOwnerDirectory();
	const db = await openInstallation(root);
	try {
		for (const phase of ["claimed", "uploading", "uploaded", "editing"]) {
			await db.use((tx) =>
				tx.run(
					sql`INSERT INTO image_job(id,binding,provider,revision,quote,state,model,created_at,poll_deadline,file_owner,file_phase,wallet_open) VALUES(${phase},'binding','poyo',1,'{}','submitting','seedream-5.5',0,120000,'first',${phase},1)`,
				),
			);
		}
		const live = fileAttemptStore(db, "first");
		const next = fileAttemptStore(db, "next");
		await live.recover(1);
		expect(await next.advance("uploaded", "uploaded", 1)).toBeFalse();
		await db.use((connection) =>
			connection.transaction((tx) => skipImageSend(tx, "uploaded", "interrupted", 1, null)),
		);
		await imageJobStore(db).recover(1);
		expect((await imageJobStore(db).get("uploaded"))?.state).toBe("submitting");
		await next.recover(2);
		const jobs = await imageJobStore(db).list();
		expect(jobs.map((j) => [j.id, j.file_phase, j.state, j.wallet_open])).toEqual([
			["claimed", "unsent", "rejected", 0],
			["editing", "edit-unknown", "unknown", 1],
			["uploaded", "stored", "rejected", 0],
			["uploading", "upload-unknown", "unknown", 1],
		]);
		expect(await live.advance("uploaded", "uploaded", 3)).toBeFalse();
	} finally {
		await db.close();
		await rm(root, { recursive: true, force: true });
	}
});

test.each([
	["claimed", "unsent", 0],
	["uploading", "upload-unknown", 1],
	["uploaded", "stored", 0],
	["editing", "edit-unknown", 1],
	["accepted", "edit-recorded", 1],
] as const)(
	"a crashed runtime at %s leaves only its recorded boundary",
	async (cut, phase, wallet) => {
		const directory = await createOwnerDirectory();
		const child = Bun.spawn(
			[process.execPath, "tests/fixtures/file-edit-process.ts", directory, cut],
			{ stdout: "pipe", stderr: "ignore" },
		);
		try {
			const { value } = await child.stdout.getReader().read();
			expect(new TextDecoder().decode(value).trim()).toBe("durable");
			await expect(openRuntimeInstallation(directory)).rejects.toThrow("in use");
			child.kill("SIGKILL");
			await child.exited;
			const db = await openRuntimeInstallation(directory);
			try {
				await fileAttemptStore(db, "next").recover(8);
				await imageJobStore(db).recover(8);
				expect(await imageJobStore(db).get("job")).toMatchObject({
					file_phase: phase,
					wallet_open: wallet,
					task_id: cut === "accepted" ? "accepted-id" : null,
				});
			} finally {
				await db.close();
			}
		} finally {
			child.kill();
			await child.exited;
			await rm(directory, { recursive: true, force: true });
		}
	},
);
