import { expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { sql } from "drizzle-orm";
import { createOwnerDirectory } from "../../../../tests/fixtures/owner-directory";
import {
	claimFileSlots,
	fileAttemptStore,
	startFileEdit,
	startFileUpload,
	undoFileEdit,
	undoFileUpload,
} from "./file-attempt";
import { imageJobStore, skipImageSend } from "./image-job-store";
import { type Installation, type InstallationTransaction, openInstallation } from "./installation";
import { recordPoyoUploadStart } from "./poyo-upload-window";
import { openRuntimeInstallation } from "./runtime-installation";

async function withJobs(
	jobs: Record<string, readonly number[]>,
	run: (db: Installation) => Promise<void>,
	references = 4,
) {
	const root = await createOwnerDirectory();
	const db = await openInstallation(root);
	try {
		for (const [id, positions] of Object.entries(jobs))
			await db.use((c) =>
				c.transaction(async (tx) => {
					await tx.run(sql`INSERT INTO image_job(id,binding,provider,revision,quote,state,model,created_at,poll_deadline,file_owner,file_phase,wallet_open)
						VALUES(${id},'binding','poyo',1,'{}','submitting','seedream-5.5',0,120000,'first','claimed',1)`);
					await claimFileSlots(tx, id, positions, references);
				}),
			);
		await run(db);
	} finally {
		await db.close();
		await rm(root, { recursive: true, force: true });
	}
}
const slots = (db: Installation, id: string) =>
	db.use((c) =>
		c.all<{ position: number; outcome: string }>(
			sql`SELECT position,outcome FROM file_slot WHERE job_id=${id} ORDER BY position`,
		),
	);
const inTx = <T>(db: Installation, work: (t: InstallationTransaction) => Promise<T>) =>
	db.use((c) => c.transaction(work, { behavior: "immediate" }));

test("each file slot cycles through uploading and uploaded in order before the edit", async () => {
	await withJobs({ job: [1, 3, 4] }, async (db) => {
		const store = fileAttemptStore(db, "first");
		// Slot 3 cannot start before slot 1 is stored.
		expect(await inTx(db, (t) => startFileUpload(t, "job", "first", 3, 1))).toBeFalse();
		expect(await inTx(db, (t) => startFileUpload(t, "job", "first", 1, 1))).toBeTrue();
		// One upload at a time, and the edit waits for every slot.
		expect(await inTx(db, (t) => startFileUpload(t, "job", "first", 3, 2))).toBeFalse();
		expect(await store.stored("job", 1, 2)).toBeTrue();
		expect(await inTx(db, (t) => startFileEdit(t, "job", "first", 3))).toBeFalse();
		for (const [slot, time] of [
			[3, 4],
			[4, 6],
		]) {
			expect(await inTx(db, (t) => startFileUpload(t, "job", "first", slot, time))).toBeTrue();
			expect(await store.stored("job", slot, time + 1)).toBeTrue();
		}
		expect(await slots(db, "job")).toEqual([
			{ position: 1, outcome: "stored" },
			{ position: 3, outcome: "stored" },
			{ position: 4, outcome: "stored" },
		]);
		// Another runtime's nonce never advances the job.
		expect(await inTx(db, (t) => startFileEdit(t, "job", "next", 8))).toBeFalse();
		expect(await inTx(db, (t) => startFileEdit(t, "job", "first", 8))).toBeTrue();
		expect((await imageJobStore(db).get("job"))?.file_phase).toBe("editing");
	});
});

test("an undone marker restores the job phase, the slot and the Poyo start together", async () => {
	await withJobs({ job: [1, 2] }, async (db) => {
		const store = fileAttemptStore(db, "first");
		const first = await inTx(db, async (t) => {
			expect(await startFileUpload(t, "job", "first", 1, 1)).toBeTrue();
			return recordPoyoUploadStart(t, 1);
		});
		await inTx(db, async (t) => {
			await undoFileUpload(t, "job", "first", 1, 1);
			await t.run(sql`DELETE FROM poyo_upload_start WHERE rowid=${first}`);
		});
		expect((await imageJobStore(db).get("job"))?.file_phase).toBe("claimed");
		expect(await slots(db, "job")).toEqual([
			{ position: 1, outcome: "unsent" },
			{ position: 2, outcome: "unsent" },
		]);
		await inTx(db, (t) => startFileUpload(t, "job", "first", 1, 2));
		await store.stored("job", 1, 3);
		await inTx(db, (t) => startFileUpload(t, "job", "first", 2, 4));
		await inTx(db, (t) => undoFileUpload(t, "job", "first", 2, 4));
		expect((await imageJobStore(db).get("job"))?.file_phase).toBe("uploaded");
		await inTx(db, (t) => startFileUpload(t, "job", "first", 2, 5));
		await store.stored("job", 2, 6);
		await inTx(db, (t) => startFileEdit(t, "job", "first", 7));
		await inTx(db, (t) => undoFileEdit(t, "job", "first", 7));
		expect((await imageJobStore(db).get("job"))?.file_phase).toBe("uploaded");
		// A marker that changed since is never undone silently.
		await expect(inTx(db, (t) => undoFileEdit(t, "job", "first", 7))).rejects.toThrow();
	});
});

test("a stop closes, keeps or reads the wallet by what was sent", async () => {
	await withJobs(
		{ none: [1, 2], unknown: [1, 2], rejected: [1, 2], first: [1, 2], stored: [1, 2] },
		async (db) => {
			const store = fileAttemptStore(db, "first");
			const upload = async (id: string, slot: number, time: number) =>
				inTx(db, (t) => startFileUpload(t, id, "first", slot, time));
			// No POST: closed uncompared.
			expect(await store.stop("none", { stop: "cooldown", slot: 1, until: 50 }, 1)).toMatchObject({
				file_phase: "unsent",
				state: "rejected",
				wallet_open: 0,
				wallet_finish_by: null,
				file_stop: "cooldown",
				file_stop_slot: 1,
				retry_at: 50,
			});
			// A middle upload with no answer: the wallet stays open, with no after-read.
			await upload("unknown", 1, 1);
			await store.stored("unknown", 1, 2);
			await upload("unknown", 2, 3);
			expect(await store.stop("unknown", { outcome: "unknown" }, 4)).toMatchObject({
				file_phase: "upload-unknown",
				state: "unknown",
				wallet_open: 1,
				wallet_finish_by: null,
			});
			// A confirmed first-upload rejection takes the bounded after-read.
			await upload("first", 1, 1);
			expect(
				await store.stop("first", { outcome: "rejected", rejection: "validation" }, 2),
			).toMatchObject({
				file_phase: "upload-rejected",
				state: "rejected",
				rejection: "validation",
				wallet_open: 1,
				wallet_finish_by: 10_002,
			});
			await upload("rejected", 1, 1);
			await store.stored("rejected", 1, 2);
			await upload("rejected", 2, 3);
			expect(await store.stop("rejected", { outcome: "rejected" }, 4)).toMatchObject({
				file_phase: "upload-rejected",
				wallet_finish_by: 10_004,
			});
			// A duplicate receipt is stored, and the edit never starts.
			await upload("stored", 1, 1);
			await store.stored("stored", 1, 2);
			await upload("stored", 2, 3);
			expect(
				await store.stop("stored", { outcome: "stored", stop: "duplicate", slot: 2, other: 1 }, 4),
			).toMatchObject({
				file_phase: "stored",
				state: "rejected",
				file_stop: "duplicate",
				file_stop_slot: 2,
				file_other_slot: 1,
				wallet_finish_by: 10_004,
			});
			expect(await slots(db, "stored")).toEqual([
				{ position: 1, outcome: "stored" },
				{ position: 2, outcome: "stored" },
			]);
			// A stopped job takes no further stop.
			expect(await store.stop("stored", { stop: "interrupted" }, 5)).toBeUndefined();
		},
	);
});

test("slot positions stay within ten references", async () => {
	await expect(withJobs({ job: [1, 11] }, async () => {}, 11)).rejects.toThrow();
	await withJobs({ job: [1] }, async (db) => {
		await expect(
			db.use((c) => c.run(sql`INSERT INTO file_slot VALUES('job',11,'unsent')`).execute()),
		).rejects.toThrow();
	});
});

test("recovery distinguishes each boundary and preserves unresolved wallets", async () => {
	await withJobs(
		{ claimed: [1, 2], uploading: [1, 2], uploaded: [1, 2], editing: [1] },
		async (db) => {
			const live = fileAttemptStore(db, "first");
			await inTx(db, (t) => startFileUpload(t, "uploading", "first", 1, 1));
			await live.stored("uploading", 1, 2);
			await inTx(db, (t) => startFileUpload(t, "uploading", "first", 2, 3));
			await inTx(db, (t) => startFileUpload(t, "uploaded", "first", 1, 1));
			await live.stored("uploaded", 1, 2);
			await inTx(db, (t) => startFileUpload(t, "editing", "first", 1, 1));
			await live.stored("editing", 1, 2);
			await inTx(db, (t) => startFileEdit(t, "editing", "first", 3));
			const next = fileAttemptStore(db, "next");
			await live.recover(1);
			await db.use((connection) =>
				connection.transaction((t) => skipImageSend(t, "uploaded", "interrupted", 1, null)),
			);
			await imageJobStore(db).recover(1);
			expect((await imageJobStore(db).get("uploaded"))?.state).toBe("submitting");
			await next.recover(4);
			const jobs = await imageJobStore(db).list();
			expect(
				jobs.map((j) => [
					j.id,
					j.file_phase,
					j.state,
					j.wallet_open,
					j.file_stop,
					j.file_stop_slot,
				]),
			).toEqual([
				["claimed", "unsent", "rejected", 0, "interrupted", 1],
				["editing", "edit-unknown", "unknown", 1, null, null],
				["uploaded", "stored", "rejected", 0, "interrupted", 2],
				["uploading", "upload-unknown", "unknown", 1, null, null],
			]);
			expect(await slots(db, "uploading")).toEqual([
				{ position: 1, outcome: "stored" },
				{ position: 2, outcome: "unknown" },
			]);
			expect(await live.stored("uploading", 2, 5)).toBeFalse();
		},
	);
});

test.each([
	["claimed", "unsent", 0, ["unsent", "unsent", "unsent"]],
	["uploading:1", "upload-unknown", 1, ["unknown", "unsent", "unsent"]],
	["uploaded:1", "stored", 0, ["stored", "unsent", "unsent"]],
	["uploading:3", "upload-unknown", 1, ["stored", "unknown", "unsent"]],
	["uploaded:3", "stored", 0, ["stored", "stored", "unsent"]],
	["uploading:4", "upload-unknown", 1, ["stored", "stored", "unknown"]],
	["uploaded:4", "stored", 0, ["stored", "stored", "stored"]],
	["editing", "edit-unknown", 1, ["stored", "stored", "stored"]],
	["accepted", "edit-recorded", 1, ["stored", "stored", "stored"]],
] as const)(
	"a three-file job whose runtime crashed at %s keeps only its recorded boundary",
	async (cut, phase, wallet, outcomes) => {
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
				await fileAttemptStore(db, "next").recover(80);
				await imageJobStore(db).recover(80);
				expect(await imageJobStore(db).get("job")).toMatchObject({
					file_phase: phase,
					wallet_open: wallet,
					task_id: cut === "accepted" ? "accepted-id" : null,
				});
				expect((await slots(db, "job")).map((slot) => slot.outcome)).toEqual([...outcomes]);
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
