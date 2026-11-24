import { afterEach, expect, test } from "bun:test";
import { createHash, createHmac } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { createOwnerDirectory } from "../../../../../tests/fixtures/owner-directory";
import { filePlaceholder } from "../../../shared/image-studio/file-edit";
import { createSeedreamDraft, type SeedreamProvider } from "../../../shared/image-studio/seedream";
import type { MediaDescriptor } from "../../../shared/media-staging/descriptor";
import { accessStore } from "../../db/access-store";
import { imageJobStore } from "../../db/image-job-store";
import type { Installation } from "../../db/installation";
import { providerStore } from "../../db/provider-store";
import { openRuntimeInstallation } from "../../db/runtime-installation";
import { type StageOptions, stageIdleMs } from "../media-staging/stages";
import { acceptedFileBinding, r1bReviewSignature } from "./accepted-binding";
import { fileDispatcher } from "./dispatch";
import { createFileQueue } from "./queue";
import type { FileRequest } from "./request";
import { bodyOf, clickFor, orderedBody, parsedRequest } from "./request.fixture";
import { openTestStages } from "./stages.fixture";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const step of cleanup.splice(0).reverse()) await step();
});
const owner = { owner: "creator", session: "session-digest" };
const url = "https://images.example.com/middle.png";

type Harness = Awaited<ReturnType<typeof harness>>;
async function harness(
	provider: SeedreamProvider,
	{
		stages: stageOptions,
		wrap = (db) => db,
		hold,
		readCleaning,
		shutdown,
	}: {
		stages?: StageOptions;
		wrap?: (db: Installation) => Installation;
		hold?: Promise<void>;
		readCleaning?: () => Promise<{ enabled: boolean; revision: number }>;
		shutdown?: AbortSignal;
	} = {},
) {
	const root = await createOwnerDirectory();
	cleanup.push(() => rm(root, { recursive: true, force: true }));
	const db = await openRuntimeInstallation(root);
	cleanup.push(() => db.close());
	const stages = await openTestStages(db, stageOptions);
	cleanup.push(() => stages.close());
	let clock = Date.now();
	const credentials = providerStore(db);
	await accessStore(db).claim(owner.owner, "unused", owner.session, clock, () => {});
	await credentials.save(provider, "reviewed-key", clock, true, 0);
	const uploads: number[][] = [];
	const edits: string[][] = [];
	const settled: Promise<unknown>[] = [];
	const dispatcher = fileDispatcher(db, "runtime", () => {}, {
		now: () => clock,
		pin: async () => async () => {
			throw new Error("unexpected transport");
		},
		balance: async () => "10",
		async upload(_provider, _key, _stage, bytes) {
			uploads.push([...bytes]);
			await hold;
			return { kind: "ready", url: `https://storage.example.org/${uploads.length}` };
		},
		async edit(_provider, _key, wire) {
			const body = wire.body as { image_urls?: string[]; input?: { image_urls: string[] } };
			edits.push(body.input?.image_urls ?? body.image_urls ?? []);
			return { kind: "accepted", taskId: "task" };
		},
	});
	const open = async (installation: Installation, signal?: AbortSignal) => {
		const opened = await createFileQueue(
			installation,
			"runtime",
			stages,
			credentials.credential,
			(...args) => {
				const work = dispatcher(...args);
				settled.push(work);
				return work;
			},
			{
				loadFeeds: async () => ({}),
				now: () => clock,
				...(readCleaning && { readCleaning }),
				...(signal && { shutdown: signal }),
			},
		);
		cleanup.push(() => opened.close());
		return opened;
	};
	const queue = await open(wrap(db), shutdown);
	const stage = (...values: number[]) => {
		const bytes = new Uint8Array(values);
		return stages.put(
			{ ...owner, draft: crypto.randomUUID() },
			{
				bytes,
				digest: createHash("sha256").update(bytes).digest("hex"),
				size: bytes.length,
				mime: "image/png",
				transform: "none",
				revision: 0,
				rotated: false,
			},
		);
	};
	const request = (references: (MediaDescriptor | string)[]) =>
		parsedRequest(
			orderedBody({ ...createSeedreamDraft(provider, "edit"), prompt: "Blend them" }, references),
		);
	const review = async (live: FileRequest) => {
		const terms = await queue.review(owner, live);
		if (!("token" in terms)) throw new Error(`Review refused: ${JSON.stringify(terms)}`);
		return { terms, click: clickFor(live, terms) };
	};
	return {
		db,
		stages,
		queue,
		uploads,
		edits,
		settled,
		stage,
		request,
		review,
		/** A new admission over the same storage and staged copies, as after a restart. */
		reopen: () => open(db),
		advance: (ms: number) => {
			clock += ms;
		},
		now: () => clock,
	};
}
const jobs = (h: Harness) => imageJobStore(h.db).list();

for (const provider of ["poyo", "toapis"] as const)
	test(`${provider}: file, URL, file uploads each file once in order, then one edit`, async () => {
		const h = await harness(provider);
		const live = h.request([await h.stage(1, 2), url, await h.stage(3, 4, 5)]);
		const { terms, click } = await h.review(live);
		expect(terms.files.map(({ position }) => position)).toEqual([1, 3]);
		expect(terms.token.startsWith("file3.")).toBeTrue();
		const queued = await h.queue.submit(owner, click);
		if (!("jobId" in queued)) throw new Error(JSON.stringify(queued));
		await Promise.all(h.settled);
		expect(h.uploads).toEqual([
			[1, 2],
			[3, 4, 5],
		]);
		expect(h.edits).toEqual([
			["https://storage.example.org/1", url, "https://storage.example.org/2"],
		]);
		expect(await imageJobStore(h.db).get(queued.jobId)).toMatchObject({
			file_phase: "edit-recorded",
			file_references: 3,
		});
		expect(
			await h.db.use((db) =>
				db.all(sql`SELECT position,outcome FROM file_slot WHERE job_id=${queued.jobId}`),
			),
		).toEqual([
			{ position: 1, outcome: "stored" },
			{ position: 3, outcome: "stored" },
		]);
		// The exact Retry replays the job with nothing sent.
		expect(await h.queue.submit(owner, click)).toEqual(queued);
		expect(h.uploads).toHaveLength(2);
	});

test("a file over Poyo.ai's limit is refused at Review and Queue with its position and no call", async () => {
	const h = await harness("poyo");
	const big = new Uint8Array(10_000_001);
	const small = await h.stage(1);
	const large = await h.stages.put(
		{ ...owner, draft: crypto.randomUUID() },
		{
			bytes: big,
			digest: createHash("sha256").update(big).digest("hex"),
			size: big.length,
			mime: "image/png",
			transform: "none",
			revision: 0,
			rotated: false,
		},
	);
	const live = h.request([small, url, large]);
	const refused = {
		error: "limit",
		provider: "poyo",
		limit: 10_000_000,
		size: 10_000_001,
		position: 3,
	} as const;
	expect(await h.queue.review(owner, live)).toEqual(refused);
	expect(
		await h.queue.submit(owner, {
			...live,
			token: `file3.${crypto.randomUUID()}.${"a".repeat(64)}.${"b".repeat(64)}`,
			acceptUnknown: true,
		}),
	).toEqual({ error: "invalid" });
	expect(h.uploads).toEqual([]);
});

test("Review extends nothing when one slot is stale, and Queue names an expired slot", async () => {
	const h = await harness("toapis");
	const [a, b, c] = [await h.stage(1), await h.stage(2), await h.stage(3)];
	await h.stages.discardDraft({ ...owner, draft: b.draft });
	expect(await h.queue.review(owner, h.request([a, b, c]))).toEqual({
		error: "stale",
		positions: [2],
	});
	const d = await h.stage(4);
	const live = h.request([a, d, c]);
	const { click } = await h.review(live);
	// Slot 2 expires between Review and Queue.
	await h.stages.discardDraft({ ...owner, draft: d.draft });
	expect(await h.queue.submit(owner, click)).toEqual({ error: "stale", positions: [2] });
	expect(await jobs(h)).toEqual([]);
});

test("a corrupt scratch copy at claim answers stale with its position", async () => {
	const h = await harness("toapis");
	const [a, b, c] = [await h.stage(1), await h.stage(2), await h.stage(3)];
	const { click } = await h.review(h.request([a, b, c]));
	await writeFile(join(h.stages.directory, c.handle), new Uint8Array([9]));
	expect(await h.queue.submit(owner, click)).toEqual({ error: "stale", positions: [3] });
	expect(await jobs(h)).toEqual([]);
	expect(h.uploads).toEqual([]);
});

/** Runs `after` with each result of `method` inside the claim transaction. */
const inClaim =
	(method: "get" | "run", after: (result: unknown) => void) =>
	(db: Installation): Installation => ({
		...db,
		use: (work) =>
			db.use((tx) =>
				work(
					new Proxy(tx, {
						get(target, key) {
							if (key !== "transaction") return Reflect.get(target, key);
							return (run: (trx: unknown) => Promise<unknown>, options: unknown) =>
								target.transaction(
									(trx) =>
										run(
											new Proxy(trx, {
												get(inner, name) {
													if (name !== method) return Reflect.get(inner, name);
													return async (query: Parameters<typeof inner.get>[0]) => {
														const result = await inner[method](query);
														after(result);
														return result;
													};
												},
											}),
										) as never,
									options as never,
								);
						},
					}),
				),
			),
	});

test("a slot that expires after the job row is written answers stale with its position", async () => {
	let stageClock = Date.now();
	let expireAfterInsert = false;
	const h = await harness("toapis", {
		stages: { now: () => stageClock },
		// The job row's INSERT is the only statement in the claim that returns an id.
		wrap: inClaim("get", (row) => {
			if (expireAfterInsert && row && typeof row === "object" && "id" in row)
				stageClock += stageIdleMs + 1;
		}),
	});
	const { click } = await h.review(h.request([url, await h.stage(2)]));
	expireAfterInsert = true;
	expect(await h.queue.submit(owner, click)).toEqual({ error: "stale", positions: [2] });
	expect(await jobs(h)).toEqual([]);
	expect(h.uploads).toEqual([]);
});

test("a slot that expires during the slot writes answers stale with its position", async () => {
	let stageClock = Date.now();
	let expire = false;
	const h = await harness("toapis", {
		stages: { now: () => stageClock },
		// The claim's only writes are its file slots and their reference count.
		wrap: inClaim("run", () => {
			if (expire) stageClock += stageIdleMs + 1;
		}),
	});
	const { click } = await h.review(h.request([url, await h.stage(2)]));
	expire = true;
	expect(await h.queue.submit(owner, click)).toEqual({ error: "stale", positions: [2] });
	expect(await jobs(h)).toEqual([]);
	expect(h.uploads).toEqual([]);
});

test("siluet:stopping closes file admission before storage closes", async () => {
	const stopping = new AbortController();
	const h = await harness("toapis", { shutdown: stopping.signal });
	const live = h.request([await h.stage(1), url]);
	const { click } = await h.review(live);
	stopping.abort();
	expect(await h.queue.review(owner, live)).toEqual({ error: "closing" });
	expect(await h.queue.submit(owner, click)).toEqual({ error: "closing" });
	expect(await jobs(h)).toEqual([]);
	expect(h.uploads).toEqual([]);
});

test("shutdown during the slot writes answers closing and the Review queues after restart", async () => {
	const stopping = new AbortController();
	let stopDuringWrites = false;
	const h = await harness("toapis", {
		shutdown: stopping.signal,
		// The claim's only writes are its file slots and their reference count.
		wrap: inClaim("run", () => {
			if (stopDuringWrites) stopping.abort();
		}),
	});
	const { click } = await h.review(h.request([await h.stage(1), url]));
	stopDuringWrites = true;
	expect(await h.queue.submit(owner, click)).toEqual({ error: "closing" });
	expect(await jobs(h)).toEqual([]);
	expect(h.uploads).toEqual([]);
	const restarted = await h.reopen();
	expect(await restarted.submit(owner, click)).toHaveProperty("jobId");
	await Promise.all(h.settled);
	expect(h.uploads).toEqual([[1]]);
});

test("an unreadable setting answers unavailable before and inside the claim", async () => {
	let broken = true;
	const h = await harness("toapis", {
		readCleaning: async () => {
			if (broken) throw new Error("unreadable");
			return { enabled: true, revision: 0 };
		},
	});
	const live = h.request([await h.stage(1), await h.stage(2)]);
	expect(await h.queue.review(owner, live)).toEqual({ error: "unavailable" });
	broken = false;
	const { click } = await h.review(live);
	broken = true;
	expect(await h.queue.submit(owner, click)).toEqual({ error: "unavailable" });
	broken = false;
	await h.db.use((db) => db.run(sql`DELETE FROM media_cleaning`));
	expect(await h.queue.submit(owner, click)).toEqual({ error: "unavailable" });
	expect(await jobs(h)).toEqual([]);
	expect(h.uploads).toEqual([]);
});

test("eight Poyo.ai upload starts refuse three files; the same Review queues after the window", async () => {
	const h = await harness("poyo");
	const live = h.request([await h.stage(1), await h.stage(2), await h.stage(3)]);
	const { click } = await h.review(live);
	await h.db.use((db) =>
		db.run(sql`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<8)
			INSERT INTO poyo_upload_start SELECT ${h.now()} FROM n`),
	);
	expect(await h.queue.submit(owner, click)).toEqual({
		error: "cooldown",
		until: h.now() + 60_000,
	});
	expect(await jobs(h)).toEqual([]);
	h.advance(60_001);
	expect(await h.queue.submit(owner, click)).toHaveProperty("jobId");
});

test("two identical first uses share one admission and one answer", async () => {
	const h = await harness("poyo");
	const live = h.request([await h.stage(1)]);
	const { click } = await h.review(live);
	// The winner's first upload start would fill the window for a second admission.
	await h.db.use((db) =>
		db.run(sql`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<9)
			INSERT INTO poyo_upload_start SELECT ${h.now()} FROM n`),
	);
	const [one, two] = await Promise.all([
		h.queue.submit(owner, click),
		h.queue.submit(owner, click),
	]);
	expect(one).toHaveProperty("jobId");
	expect(two).toEqual(one);
	await Promise.all(h.settled);
	expect(h.uploads).toHaveLength(1);
});

test("a contender whose lookup missed the winner's commit replays the winner, not a refusal", async () => {
	let holdNext = false;
	const gate = Promise.withResolvers<void>();
	const looked = Promise.withResolvers<void>();
	const h = await harness("toapis", {
		wrap: (db) => ({
			...db,
			use: async (work) => {
				const held = holdNext;
				holdNext = false;
				const result = await db.use(work);
				if (held) {
					looked.resolve();
					await gate.promise;
				}
				return result;
			},
		}),
	});
	const live = h.request([await h.stage(1), url]);
	const { click } = await h.review(live);
	holdNext = true;
	const late = h.queue.submit(owner, click);
	// The late contender has looked up and found no job yet.
	await looked.promise;
	const winner = await h.queue.submit(owner, click);
	expect(winner).toHaveProperty("jobId");
	gate.resolve();
	expect(await late).toEqual(winner);
	expect(await jobs(h)).toHaveLength(1);
});

test("reversed overlapping Reviews: one claims, the other is busy, then stale for the claimed copy", async () => {
	const release = Promise.withResolvers<void>();
	const h = await harness("toapis", { hold: release.promise });
	const [a, b] = [await h.stage(1), await h.stage(2)];
	const first = await h.review(h.request([a, b]));
	const second = await h.review(h.request([b, a]));
	const winner = await h.queue.submit(owner, first.click);
	expect(winner).toHaveProperty("jobId");
	expect(await h.queue.submit(owner, second.click)).toEqual({ error: "stale", positions: [1, 2] });
	release.resolve();
	await Promise.all(h.settled);
});

test("a busy buffer refuses before claim and the same Review queues once it frees", async () => {
	const release = Promise.withResolvers<void>();
	const h = await harness("toapis", { stages: { buffers: 3 }, hold: release.promise });
	const first = await h.review(h.request([await h.stage(1, 2, 3)]));
	const second = await h.review(h.request([await h.stage(4, 5)]));
	expect(await h.queue.submit(owner, first.click)).toHaveProperty("jobId");
	expect(await h.queue.submit(owner, second.click)).toEqual({ error: "busy" });
	release.resolve();
	await Promise.all(h.settled);
	expect(await h.queue.submit(owner, second.click)).toHaveProperty("jobId");
});

test("R1b bodies: Review is invalid, an unused Queue is stale, a claimed one replays with its guards", async () => {
	const h = await harness("poyo");
	const stage = await h.stage(9);
	const r1bBody = (token: string, acceptUnknown = true) => ({
		draft: {
			...createSeedreamDraft("poyo", "edit"),
			prompt: "Draw a peaceful meadow",
			references: [{ kind: "upload", url: filePlaceholder }],
		},
		stage,
		count: 1,
		retryLimit: 0,
		acceptUnknown,
		token,
	});
	const secret = await h.db.use((db) =>
		db.get<{ secret: string }>(sql`SELECT secret FROM image_review_key`),
	);
	const mac = (...parts: unknown[]) =>
		createHmac("sha256", Buffer.from(secret?.secret ?? "", "hex"))
			.update(JSON.stringify(parts))
			.digest("hex");
	const id = crypto.randomUUID();
	const terms = "c".repeat(64);
	const unsigned = parsedRequest(r1bBody(`file2.${id}.${terms}.${"0".repeat(64)}`));
	const signed = r1bReviewSignature(mac, id, terms, owner.owner, owner.session, unsigned);
	const token = `file2.${id}.${terms}.${signed}`;
	const live = parsedRequest(r1bBody(token));
	// R1b's Review body is gone; a file3 token never rides on it.
	expect(await h.queue.review(owner, live)).toEqual({ error: "invalid" });
	expect(await h.queue.submit(owner, unsigned)).toEqual({ error: "invalid" });
	expect(await h.queue.submit(owner, live)).toEqual({ error: "stale" });
	expect(await h.queue.submit(owner, { ...live, token: token.replace("file2", "file3") })).toEqual({
		error: "invalid",
	});
	const v3 = h.request([stage]);
	expect(await h.queue.submit(owner, { ...v3, token, acceptUnknown: true })).toEqual({
		error: "invalid",
	});
	expect(await h.queue.review(owner, { ...v3, token })).toEqual({ error: "invalid" });
	expect(h.uploads).toEqual([]);
	// A job R1b claimed for this exact body, as the upgrade left it.
	const binding = acceptedFileBinding(mac, owner.owner, token, live);
	await h.db.use((db) =>
		db.transaction(async (tx) => {
			await tx.run(sql`INSERT INTO image_job(id,binding,provider,revision,quote,state,model,created_at,poll_deadline,file_owner,file_phase,file_references,task_id,submission_recorded_at)
				VALUES(${id},${binding},'poyo',0,'{}','waiting','seedream-5.5',1,120003,'r1b','edit-recorded',1,'task',3)`);
			await tx.run(sql`INSERT INTO file_slot VALUES(${id},1,'stored')`);
		}),
	);
	expect(await h.queue.submit(owner, live)).toEqual({ jobId: id });
	const altered = parsedRequest({
		...r1bBody(token),
		draft: { ...r1bBody(token).draft, prompt: "Changed" },
	});
	expect(await h.queue.submit(owner, altered)).toEqual({ error: "invalid" });
	expect(await h.queue.submit(owner, parsedRequest(r1bBody(token, false)))).toEqual({
		error: "invalid",
	});
	await accessStore(h.db).revoke(owner.session);
	expect(await h.queue.submit(owner, live)).toEqual({ error: "invalid" });
	expect(h.uploads).toEqual([]);
});

test("terms drift answers stale without positions and keeps every staged copy", async () => {
	const h = await harness("toapis");
	const live = h.request([await h.stage(1), await h.stage(2)]);
	const { click } = await h.review(live);
	await providerStore(h.db).save("toapis", "replacement", h.now(), true, 1);
	expect(await h.queue.submit(owner, click)).toEqual({ error: "stale" });
	expect(await h.queue.review(owner, parsedRequest(bodyOf(live)))).toHaveProperty("token");
});
