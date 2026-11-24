import { expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { sql } from "drizzle-orm";
import { createOwnerDirectory } from "../../../../../tests/fixtures/owner-directory";
import { filePlaceholder } from "../../../shared/image-studio/file-edit";
import { createSeedreamDraft } from "../../../shared/image-studio/seedream";
import { imageJobStore } from "../../db/image-job-store";
import { openInstallation } from "../../db/installation";
import { providerStore } from "../../db/provider-store";
import { pinFilePost } from "../../providers/file-post";
import { summarizeJob } from "../jobs/summary";
import { fileDispatcher } from "./dispatch";
import { parseFileRequest } from "./request";
import { sendFileEdit, uploadFile } from "./transfer";

async function claimedFile(
	db: Awaited<ReturnType<typeof openInstallation>>,
	provider: "poyo" | "toapis",
) {
	await providerStore(db).save(provider, "fixture", 0, true, 0);
	await db.use((tx) =>
		tx.run(
			sql`INSERT INTO image_job(id,binding,provider,revision,quote,state,model,created_at,poll_deadline,file_owner,file_phase) VALUES('file','binding',${provider},1,'{}','submitting',${provider === "poyo" ? "seedream-5.5" : "doubao-seedream-5-5"},0,120000,'runtime','claimed')`,
		),
	);
	const live = parseFileRequest({
		draft: {
			...createSeedreamDraft(provider, "edit"),
			prompt: "Draw the garden again",
			references: [{ kind: "upload", url: filePlaceholder }],
		},
		stage: {
			draft: crypto.randomUUID(),
			handle: crypto.randomUUID(),
			size: 1,
			digest: "f".repeat(64),
			mime: "image/png",
			transform: "none",
			deadline: 100,
		},
		count: 1,
		retryLimit: 0,
		acceptUnknown: true,
	});
	if (!live) throw new Error("Invalid file fixture");
	return live;
}
for (const outcome of [
	{ kind: "stored" },
	{ kind: "ready", url: "https://storage.example.org/reference" },
	{ kind: "unknown" },
	{ kind: "rejected", reason: "quota" },
	{ kind: "window-full" },
	{ kind: "pre-upload-cooldown" },
] as const) {
	test(`Poyo wallet and edit boundary after ${outcome.kind} upload`, async () => {
		const dir = await createOwnerDirectory();
		let db = await openInstallation(dir);
		try {
			const live = await claimedFile(db, "poyo");
			let balances = 0,
				releases = 0,
				uploads = 0,
				edits = 0;
			const dispatch = fileDispatcher(db, "runtime", () => {}, {
				pin: async () => {
					if (outcome.kind === "window-full")
						await db.use((tx) =>
							tx.run(sql`WITH RECURSIVE starts(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM starts WHERE i<10)
							INSERT INTO poyo_upload_start SELECT 10 FROM starts`),
						);
					return async () => {
						throw new Error("unexpected transport");
					};
				},
				now: () => 10,
				async upload() {
					if (outcome.kind === "window-full" || outcome.kind === "pre-upload-cooldown")
						throw new Error("Unexpected upload");
					if (outcome.kind === "ready")
						await db.use((tx) =>
							tx.run(sql`UPDATE provider_gate SET submit_after=200 WHERE provider='poyo'`),
						);
					uploads++;
					return outcome;
				},
				async edit() {
					edits++;
					return { kind: "unknown" };
				},
				async balance() {
					balances++;
					if (outcome.kind === "pre-upload-cooldown" && balances === 1)
						await db.use((tx) =>
							tx.run(sql`UPDATE provider_gate SET submit_after=200 WHERE provider='poyo'`),
						);
					return balances === 1 ? "10" : "8";
				},
			});
			const held = {
				bytes: new Uint8Array(1),
				release: () => {
					releases++;
				},
			};
			await dispatch("file", "fixture", live, held);
			await dispatch("file", "fixture", live, held);
			await db.close();
			db = await openInstallation(dir);
			const jobs = imageJobStore(db);
			const row = await jobs.get("file");
			if (!row) throw new Error("Missing file job after restart");
			const zeroUpload = outcome.kind === "window-full" || outcome.kind === "pre-upload-cooldown";
			if (outcome.kind === "ready" || zeroUpload) {
				const until = outcome.kind === "window-full" ? 60_010 : 200;
				expect(row.retry_at).toBe(until);
				expect(summarizeJob(row, true, until + 1).message).toBe(
					`Provider cooldown until ${new Date(until).toISOString()}. Review again before queuing.`,
				);
			}
			if (zeroUpload) {
				expect(await jobs.get("file")).toMatchObject({
					file_phase: "unsent",
					wallet_open: 0,
					wallet_after: null,
				});
				expect([uploads, edits, balances, releases]).toEqual([0, 0, 1, 2]);
				expect(
					await db.use((tx) => tx.get(sql`SELECT count(*) AS n FROM poyo_upload_start`)),
				).toEqual({ n: outcome.kind === "window-full" ? 10 : 0 });
				return;
			}
			const unknown = outcome.kind === "unknown";
			expect(await jobs.get("file")).toMatchObject({
				wallet_open: Number(unknown),
				wallet_before: "10",
				wallet_after: unknown ? null : "8",
				state: unknown ? "unknown" : "rejected",
			});
			if (outcome.kind === "ready") expect((await jobs.get("file"))?.file_phase).toBe("stored");
			expect([uploads, edits, releases, balances]).toEqual([1, 0, 2, unknown ? 1 : 2]);
			await db.use((tx) =>
				tx.run(
					sql`INSERT INTO image_job(id,binding,provider,revision,quote,state,model,created_at,poll_deadline) VALUES('next','next','poyo',2,'{}','submitting','seedream-5.5',0,120000)`,
				),
			);
			await jobs.beginDispatch("next", "poyo", 20);
			expect((await jobs.get("next"))?.wallet_overlap).toBe(Number(unknown));
		} finally {
			await db.close();
			await rm(dir, { recursive: true, force: true });
		}
	});
}

test.each(["poyo", "toapis"] as const)(
	"%s expiry during edit pin keeps the uploaded copy and sends zero edits",
	async (provider) => {
		const dir = await createOwnerDirectory();
		const db = await openInstallation(dir);
		try {
			const live = await claimedFile(db, provider);
			let time = 10,
				edits = 0,
				uploads = 0;
			const dispatch = fileDispatcher(db, "runtime", () => {}, {
				now: () => time,
				pin: async (url) => {
					if (url === live.request.url) time = 20;
					return async () => {
						throw new Error("unexpected transport");
					};
				},
				balance: async () => "10",
				async upload() {
					uploads++;
					return { kind: "ready", url: "https://storage.example.org/reference", expiresAt: 20 };
				},
				async edit() {
					edits++;
					return { kind: "accepted", taskId: "unexpected" };
				},
			});
			await dispatch("file", "fixture", live, { bytes: new Uint8Array(1), release() {} });
			expect([uploads, edits]).toEqual([1, 0]);
			expect(await imageJobStore(db).get("file")).toMatchObject({
				state: "rejected",
				file_phase: "stored",
				task_id: null,
				wallet_open: 0,
			});
			expect(
				await db.use((tx) =>
					tx.get(sql`SELECT count(*) AS starts FROM provider_start WHERE kind='submit'`),
				),
			).toEqual({ starts: 0 });
		} finally {
			await db.close();
			await rm(dir, { recursive: true, force: true });
		}
	},
);

test.each(["before", "during"] as const)(
	"a Poyo key rotation %s the closing wallet read leaves the comparison unavailable",
	async (when) => {
		const dir = await createOwnerDirectory();
		const db = await openInstallation(dir);
		try {
			const live = await claimedFile(db, "poyo");
			const keys = providerStore(db);
			const rotate = () => keys.save("poyo", "replacement", 15, true, 1);
			const balanceKeys: string[] = [];
			let edits = 0;
			const dispatch = fileDispatcher(db, "runtime", () => {}, {
				pin: async () => async () => {
					throw new Error("unexpected transport");
				},
				now: () => 20,
				upload: async () => ({ kind: "ready", url: "https://storage.example.org/reference" }),
				async edit() {
					edits++;
					if (when === "before") await rotate();
					return { kind: "rejected", reason: "quota" };
				},
				async balance(key) {
					balanceKeys.push(key);
					if (balanceKeys.length === 1) return "10";
					if (when === "during") await rotate();
					return "8";
				},
			});
			await dispatch("file", "fixture", live, { bytes: new Uint8Array(1), release() {} });
			expect(edits).toBe(1);
			expect(balanceKeys).toEqual(when === "before" ? ["fixture"] : ["fixture", "fixture"]);
			expect(await imageJobStore(db).get("file")).toMatchObject({
				revision: 1,
				state: "rejected",
				file_phase: "edit-recorded",
				wallet_open: 0,
				wallet_before: "10",
				wallet_after: null,
				wallet_after_at: null,
			});
		} finally {
			await db.close();
			await rm(dir, { recursive: true, force: true });
		}
	},
);

test("expiry after the file edit marker preserves the upload and reverses only the unsent generation start", async () => {
	const root = await createOwnerDirectory();
	const db = await openInstallation(root);
	try {
		const live = await claimedFile(db, "poyo");
		const expiresAt = 20;
		let time = 10,
			physical = 0;
		await db.use((tx) => tx.run(sql`INSERT INTO provider_start VALUES('poyo','submit',10)`));
		const dispatch = fileDispatcher(db, "runtime", () => {}, {
			now: () => time,
			balance: async () => "10",
			pin: async (endpoint, timeout) =>
				pinFilePost(
					endpoint,
					timeout,
					async () => "93.184.216.34",
					async () => {
						physical++;
						return Response.json({ code: 200, data: { task_id: "unexpected" } });
					},
				),
			upload: async () => ({
				kind: "ready",
				url: "https://storage.example.org/reference",
				expiresAt,
			}),
			edit: (provider, key, request, read) => {
				time = expiresAt;
				return sendFileEdit(provider, key, request, read);
			},
		});
		await dispatch("file", "fixture", live, { bytes: new Uint8Array(1), release() {} });
		expect(physical).toBe(0);
		expect(await imageJobStore(db).get("file")).toMatchObject({
			state: "rejected",
			file_phase: "stored",
			task_id: null,
			wallet_open: 0,
		});
		expect(
			await db.use((tx) => tx.get(sql`SELECT count(*) n FROM provider_start WHERE kind='submit'`)),
		).toEqual({ n: 1 });
		expect(await db.use((tx) => tx.get(sql`SELECT count(*) n FROM poyo_upload_start`))).toEqual({
			n: 1,
		});
	} finally {
		await db.close();
		await rm(root, { recursive: true, force: true });
	}
});

test("a Poyo pin expiring before physical upload consumes neither an upload start nor an edit", async () => {
	const root = await createOwnerDirectory();
	const db = await openInstallation(root);
	try {
		const live = await claimedFile(db, "poyo");
		let monotonic = 0,
			physical = 0,
			edits = 0;
		await db.use((tx) => tx.run(sql`INSERT INTO poyo_upload_start VALUES(10)`));
		const dispatch = fileDispatcher(db, "runtime", () => {}, {
			now: () => 10,
			balance: async () => "10",
			pin: async (endpoint) =>
				pinFilePost(
					endpoint,
					100,
					async () => "93.184.216.34",
					async () => {
						physical++;
						return Response.json({});
					},
					() => monotonic,
				),
			upload: async (provider, key, stage, bytes, read) => {
				monotonic = 100;
				return uploadFile(provider, key, stage, bytes, read);
			},
			edit: async () => {
				edits++;
				return { kind: "unknown" };
			},
		});
		await dispatch("file", "fixture", live, { bytes: new Uint8Array(1), release() {} });
		expect([physical, edits]).toEqual([0, 0]);
		expect(await imageJobStore(db).get("file")).toMatchObject({
			state: "rejected",
			file_phase: "unsent",
			wallet_open: 0,
		});
		expect(await db.use((tx) => tx.all(sql`SELECT rowid,started FROM poyo_upload_start`))).toEqual([
			{ rowid: 1, started: 10 },
		]);
	} finally {
		await db.close();
		await rm(root, { recursive: true, force: true });
	}
});
