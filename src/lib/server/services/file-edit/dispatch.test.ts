import { expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { sql } from "drizzle-orm";
import { createOwnerDirectory } from "../../../../../tests/fixtures/owner-directory";
import { createSeedreamDraft } from "../../../shared/image-studio/seedream";
import { claimFileSlots } from "../../db/file-attempt";
import { imageJobStore } from "../../db/image-job-store";
import { openInstallation } from "../../db/installation";
import { providerStore } from "../../db/provider-store";
import { pinFilePost } from "../../providers/file-post";
import { summarizeJob } from "../jobs/summary";
import { fileDispatcher } from "./dispatch";
import { orderedBody, parsedRequest } from "./request.fixture";
import { heldBytes } from "./stages.fixture";
import { sendFileEdit, uploadFile } from "./transfer";

async function claimedFile(
	db: Awaited<ReturnType<typeof openInstallation>>,
	provider: "poyo" | "toapis",
) {
	await providerStore(db).save(provider, "fixture", 0, true, 0);
	await db.use((c) =>
		c.transaction(async (tx) => {
			await tx.run(
				sql`INSERT INTO image_job(id,binding,provider,revision,quote,state,model,created_at,poll_deadline,file_owner,file_phase) VALUES('file','binding',${provider},1,'{}','submitting',${provider === "poyo" ? "seedream-5.5" : "doubao-seedream-5-5"},0,120000,'runtime','claimed')`,
			);
			await claimFileSlots(tx, "file", [1], 1);
		}),
	);
	return parsedRequest(
		orderedBody(
			{ ...createSeedreamDraft(provider, "edit"), prompt: "Draw the garden again" },
			[
				{
					draft: crypto.randomUUID(),
					handle: crypto.randomUUID(),
					size: 1,
					digest: "f".repeat(64),
					mime: "image/png",
					transform: "none",
					deadline: 100,
				},
			],
			{ acceptUnknown: true },
		),
	);
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
			const held = heldBytes(new Uint8Array(1), () => {
				releases++;
			});
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
			await dispatch("file", "fixture", live, heldBytes(new Uint8Array(1)));
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
			await dispatch("file", "fixture", live, heldBytes(new Uint8Array(1)));
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
		await dispatch("file", "fixture", live, heldBytes(new Uint8Array(1)));
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
		await dispatch("file", "fixture", live, heldBytes(new Uint8Array(1)));
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

test("a stop frees the buffer and the Poyo upload slot before its closing wallet read", async () => {
	const root = await createOwnerDirectory();
	const db = await openInstallation(root);
	try {
		const live = await claimedFile(db, "poyo");
		const events: string[] = [];
		const dispatch = fileDispatcher(db, "runtime", () => {}, {
			now: () => 10,
			pin: async () => async () => {
				throw new Error("unexpected transport");
			},
			balance: async () => {
				events.push("balance");
				return "10";
			},
			upload: async () => ({ kind: "rejected", reason: "quota" }),
			edit: async () => ({ kind: "unknown" }),
		});
		await dispatch(
			"file",
			"fixture",
			live,
			heldBytes(new Uint8Array(1), () => events.push("release")),
		);
		expect(events).toEqual(["balance", "release", "balance"]);
		expect(await imageJobStore(db).get("file")).toMatchObject({
			wallet_open: 0,
			wallet_after: "10",
		});
	} finally {
		await db.close();
		await rm(root, { recursive: true, force: true });
	}
});

test("a shutdown that begins after the upload marker sends nothing and undoes the Poyo window entry", async () => {
	const root = await createOwnerDirectory();
	const db = await openInstallation(root);
	try {
		const live = await claimedFile(db, "poyo");
		let closing = false,
			physical = 0,
			edits = 0;
		const dispatch = fileDispatcher(db, "runtime", () => {}, {
			now: () => 10,
			balance: async () => "10",
			pin: async (endpoint) =>
				pinFilePost(
					endpoint,
					60_000,
					async () => "93.184.216.34",
					async () => {
						physical++;
						return Response.json({});
					},
				),
			// The marker has committed; shutdown begins as the transport is handed the body.
			upload: async (provider, key, stage, bytes, read) => {
				closing = true;
				return uploadFile(provider, key, stage, bytes, read);
			},
			edit: async () => {
				edits++;
				return { kind: "unknown" };
			},
		});
		await dispatch("file", "fixture", live, heldBytes(new Uint8Array(1)), () => closing);
		expect([physical, edits]).toEqual([0, 0]);
		expect(await imageJobStore(db).get("file")).toMatchObject({
			state: "rejected",
			file_phase: "unsent",
			file_stop: "interrupted",
			file_stop_slot: 1,
			wallet_open: 0,
		});
		expect(await slotOutcomes(db)).toEqual([{ position: 1, outcome: "unsent" }]);
		expect(await db.use((tx) => tx.all(sql`SELECT started FROM poyo_upload_start`))).toEqual([]);
	} finally {
		await db.close();
		await rm(root, { recursive: true, force: true });
	}
});

const middle = "https://images.example.com/middle.png";
/** A claimed file, URL, file job with slots 1 and 3, and a handle over each file's bytes. */
async function claimedOrdered(
	db: Awaited<ReturnType<typeof openInstallation>>,
	provider: "poyo" | "toapis",
) {
	await providerStore(db).save(provider, "fixture", 0, true, 0);
	await db.use((c) =>
		c.transaction(async (tx) => {
			await tx.run(
				sql`INSERT INTO image_job(id,binding,provider,revision,quote,state,model,created_at,poll_deadline,file_owner,file_phase) VALUES('file','binding',${provider},1,'{}','submitting',${provider === "poyo" ? "seedream-5.5" : "doubao-seedream-5-5"},0,120000,'runtime','claimed')`,
			);
			await claimFileSlots(tx, "file", [1, 3], 3);
		}),
	);
	const stage = (digest: string) => ({
		draft: crypto.randomUUID(),
		handle: crypto.randomUUID(),
		size: 2,
		digest: digest.repeat(64),
		mime: "image/png" as const,
		transform: "none" as const,
		deadline: 100,
	});
	return parsedRequest(
		orderedBody(
			{ ...createSeedreamDraft(provider, "edit"), prompt: "Blend them" },
			[stage("a"), middle, stage("b")],
			{ acceptUnknown: true },
		),
	);
}
const slotOutcomes = (db: Awaited<ReturnType<typeof openInstallation>>) =>
	db.use((c) =>
		c.all<{ position: number; outcome: string }>(
			sql`SELECT position,outcome FROM file_slot WHERE job_id='file' ORDER BY position`,
		),
	);
const files = [new Uint8Array([1, 2]), new Uint8Array([3, 4])];
const ordered = (next = async (index: number) => files[index]) => {
	let released = 0;
	return {
		held: { next, release: async () => void released++ },
		released: () => released,
	};
};

for (const provider of ["poyo", "toapis"] as const) {
	test(`${provider}: a 429 on the second file is unknown, keeps the wallet open and sends no edit`, async () => {
		const dir = await createOwnerDirectory();
		const db = await openInstallation(dir);
		try {
			const live = await claimedOrdered(db, provider);
			const sent: number[][] = [];
			let edits = 0;
			const dispatch = fileDispatcher(db, "runtime", () => {}, {
				now: () => 10,
				pin: async () => async () => {
					throw new Error("unexpected transport");
				},
				balance: async () => "10",
				async upload(_provider, _key, _stage, bytes) {
					sent.push([...bytes]);
					return sent.length === 1
						? { kind: "ready", url: "https://storage.example.org/1" }
						: { kind: "unknown" };
				},
				async edit() {
					edits++;
					return { kind: "unknown" };
				},
			});
			const { held, released } = ordered();
			await dispatch("file", "fixture", live, held);
			expect(sent).toEqual([
				[1, 2],
				[3, 4],
			]);
			expect([edits, released()]).toEqual([0, 1]);
			expect(await imageJobStore(db).get("file")).toMatchObject({
				state: "unknown",
				file_phase: "upload-unknown",
				wallet_open: Number(provider === "poyo"),
				wallet_after: null,
			});
			expect(await slotOutcomes(db)).toEqual([
				{ position: 1, outcome: "stored" },
				{ position: 3, outcome: "unknown" },
			]);
			// A replacement key cannot attribute this account's movement to a later job.
			await providerStore(db).save(provider, "replacement", 20, true, 1);
			await db.use((tx) =>
				tx.run(
					sql`INSERT INTO image_job(id,binding,provider,revision,quote,state,model,created_at,poll_deadline) VALUES('next','next',${provider},2,'{}','submitting','seedream-5.5',0,120000)`,
				),
			);
			await imageJobStore(db).beginDispatch("next", provider, 30);
			expect((await imageJobStore(db).get("next"))?.wallet_overlap).toBe(
				Number(provider === "poyo"),
			);
		} finally {
			await db.close();
			await rm(dir, { recursive: true, force: true });
		}
	});

	test(`${provider}: a receipt equal to the middle URL stops the last file and the edit`, async () => {
		const dir = await createOwnerDirectory();
		const db = await openInstallation(dir);
		try {
			const live = await claimedOrdered(db, provider);
			let uploads = 0,
				edits = 0;
			const dispatch = fileDispatcher(db, "runtime", () => {}, {
				now: () => 10,
				pin: async () => async () => {
					throw new Error("unexpected transport");
				},
				balance: async () => "10",
				async upload() {
					uploads++;
					return { kind: "ready", url: middle };
				},
				async edit() {
					edits++;
					return { kind: "unknown" };
				},
			});
			await dispatch("file", "fixture", live, ordered().held);
			expect([uploads, edits]).toEqual([1, 0]);
			expect(await imageJobStore(db).get("file")).toMatchObject({
				state: "rejected",
				file_phase: "stored",
				file_stop: "duplicate",
				file_stop_slot: 1,
				file_other_slot: 2,
			});
			expect(await slotOutcomes(db)).toEqual([
				{ position: 1, outcome: "stored" },
				{ position: 3, outcome: "unsent" },
			]);
		} finally {
			await db.close();
			await rm(dir, { recursive: true, force: true });
		}
	});

	test(`${provider}: a later stage that changed is never sent`, async () => {
		const dir = await createOwnerDirectory();
		const db = await openInstallation(dir);
		try {
			const live = await claimedOrdered(db, provider);
			const sent: number[][] = [];
			const dispatch = fileDispatcher(db, "runtime", () => {}, {
				now: () => 10,
				pin: async () => async () => {
					throw new Error("unexpected transport");
				},
				balance: async () => "10",
				async upload(_provider, _key, _stage, bytes) {
					sent.push([...bytes]);
					return { kind: "ready", url: "https://storage.example.org/1" };
				},
			});
			const { held, released } = ordered(async (index) => {
				if (index === 1) throw new Error("Staged file changed.");
				return files[index];
			});
			await dispatch("file", "fixture", live, held);
			expect(sent).toEqual([[1, 2]]);
			expect(released()).toBe(1);
			expect(await imageJobStore(db).get("file")).toMatchObject({
				file_phase: "stored",
				file_stop: "stage-changed",
				file_stop_slot: 3,
			});
		} finally {
			await db.close();
			await rm(dir, { recursive: true, force: true });
		}
	});

	test(`${provider}: shutdown during the second upload sends no later file or edit`, async () => {
		const dir = await createOwnerDirectory();
		const db = await openInstallation(dir);
		try {
			await providerStore(db).save(provider, "fixture", 0, true, 0);
			await db.use((c) =>
				c.transaction(async (tx) => {
					await tx.run(
						sql`INSERT INTO image_job(id,binding,provider,revision,quote,state,model,created_at,poll_deadline,file_owner,file_phase) VALUES('file','binding',${provider},1,'{}','submitting','seedream-5.5',0,120000,'runtime','claimed')`,
					);
					await claimFileSlots(tx, "file", [1, 2, 3], 3);
				}),
			);
			const stage = (digest: string) => ({
				draft: crypto.randomUUID(),
				handle: crypto.randomUUID(),
				size: 2,
				digest: digest.repeat(64),
				mime: "image/png" as const,
				transform: "none" as const,
				deadline: 100,
			});
			const live = parsedRequest(
				orderedBody(
					{ ...createSeedreamDraft(provider, "edit"), prompt: "Blend them" },
					[stage("a"), stage("b"), stage("c")],
					{ acceptUnknown: true },
				),
			);
			let closing = false;
			let uploads = 0,
				edits = 0;
			const dispatch = fileDispatcher(db, "runtime", () => {}, {
				now: () => 10,
				pin: async () => async () => {
					throw new Error("unexpected transport");
				},
				balance: async () => "10",
				async upload() {
					uploads++;
					// Shutdown begins once the second upload is in flight, after its handoff.
					await Promise.resolve();
					if (uploads === 2) closing = true;
					return { kind: "ready", url: `https://storage.example.org/${uploads}` };
				},
				async edit() {
					edits++;
					return { kind: "unknown" };
				},
			});
			await dispatch(
				"file",
				"fixture",
				live,
				{ next: async () => new Uint8Array(2), release: async () => {} },
				() => closing,
			);
			expect([uploads, edits]).toEqual([2, 0]);
			expect(await imageJobStore(db).get("file")).toMatchObject({
				state: "rejected",
				file_phase: "stored",
				file_stop: "interrupted",
				file_stop_slot: 3,
			});
		} finally {
			await db.close();
			await rm(dir, { recursive: true, force: true });
		}
	});

	test(`${provider}: an expired hosted link stops the edit and names its slot`, async () => {
		const dir = await createOwnerDirectory();
		const db = await openInstallation(dir);
		try {
			const live = await claimedOrdered(db, provider);
			let time = 10,
				uploads = 0,
				edits = 0;
			const dispatch = fileDispatcher(db, "runtime", () => {}, {
				now: () => time,
				pin: async (endpoint) => {
					if (endpoint === live.request.url) time = 50;
					return async () => {
						throw new Error("unexpected transport");
					};
				},
				balance: async () => "10",
				async upload() {
					uploads++;
					return {
						kind: "ready",
						url: `https://storage.example.org/${uploads}`,
						...(uploads === 2 && { expiresAt: 40 }),
					};
				},
				async edit() {
					edits++;
					return { kind: "unknown" };
				},
			});
			await dispatch("file", "fixture", live, ordered().held);
			expect([uploads, edits]).toEqual([2, 0]);
			expect(await imageJobStore(db).get("file")).toMatchObject({
				file_phase: "stored",
				file_stop: "expired-link",
				file_stop_slot: 3,
			});
		} finally {
			await db.close();
			await rm(dir, { recursive: true, force: true });
		}
	});
}
