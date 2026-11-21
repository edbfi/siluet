import { afterEach, beforeEach, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { sql } from "drizzle-orm";
import { createOwnerDirectory } from "../../../../../tests/fixtures/owner-directory";
import {
	buildSeedreamRequest,
	createSeedreamDraft,
	validateSeedreamDraft,
} from "../../../shared/image-studio/seedream";
import type { ProviderId } from "../../../shared/providers/connections";
import { imageJobPollingWindowMs, imageJobSchema } from "../../db/image-job-schema";
import { type Installation, openInstallation } from "../../db/installation";
import type { CheckFetch } from "../../providers/connection-check";
import { createJobTracking } from "./tracking";

const start = 1_799_000_000_000;
const taskId = "task-fixture-542";
const signedUrl = "https://cdn.example.net/media/sample.png?secret=signed-result-sentinel";
const prompt = "A vibrant orange prompt-sentinel";
const quote = { status: "unknown", reason: "missing-feed", maxAttempts: 1 } as const;
const credential = "key-sentinel";
let now: number;
let directory: string;
let installation: Installation;
let tracker: ReturnType<typeof createJobTracking> | undefined;

beforeEach(async () => {
	now = start;
	directory = await createOwnerDirectory();
	installation = await openInstallation(directory);
	await installation.use(async (db) => {
		if (!(await db.get(sql`SELECT name FROM sqlite_master WHERE name='image_job'`)))
			await db.run(sql.raw(imageJobSchema));
		await db.run(sql`CREATE TABLE IF NOT EXISTS gallery_image (
			job_id TEXT PRIMARY KEY REFERENCES image_job(id), state TEXT NOT NULL
		)`);
		await db.run(sql`UPDATE provider_credential SET revision=1, seedream=1,
			ciphertext='test-credential', verified_at=0`);
	});
});

afterEach(async () => {
	tracker?.close();
	await installation.close();
	await rm(directory, { recursive: true, force: true });
});

const latest = async (id = "job") => (await tracker?.list())?.find((job) => job.id === id);
const insert = (id = "job", provider: ProviderId = "toapis") =>
	installation.use((db) =>
		db.run(sql`INSERT INTO image_job (id,binding,provider,revision,quote,state,created_at,model,poll_deadline)
			VALUES (${id},'binding',${provider},1,${JSON.stringify(quote)},'submitting',${now},
				${provider === "poyo" ? "seedream-5.5" : "doubao-seedream-5-5"},${now + imageJobPollingWindowMs})`),
	);

function makeTracking(read: CheckFetch) {
	tracker = createJobTracking(
		installation,
		async (provider, revision) => {
			const row = await installation.use((db) =>
				db.get(sql`SELECT revision FROM provider_credential WHERE provider=${provider}
					AND revision=${revision} AND ciphertext IS NOT NULL`),
			);
			return row ? credential : null;
		},
		{ fetch: read, now: () => now, random: () => 0 },
	);
	return tracker;
}

function dispatch(provider: ProviderId, id = "job") {
	const validation = validateSeedreamDraft({ ...createSeedreamDraft(provider), prompt });
	if (!validation.ok || !tracker) throw new Error("Invalid fixture");
	return tracker.dispatch(
		id,
		provider,
		credential,
		buildSeedreamRequest(validation.input, () => ""),
	);
}

async function reopen(read: CheckFetch) {
	tracker?.close();
	await installation.close();
	installation = await openInstallation(directory);
	return makeTracking(read);
}

const acceptToapis = () => Response.json({ id: taskId, status: "pending" });
const completedToapis = () =>
	Response.json({
		id: taskId,
		status: "completed",
		expires_at: (start + 300_000) / 1_000,
		result: { type: "image", data: [{ url: signedUrl }] },
		billing: { status: "settled", credits: "1.007", cost_usd: "0.0215" },
	});

test("startup keeps an orphaned claim uncertain and never sends its reserved attempt", async () => {
	await insert();
	let calls = 0;
	const jobs = makeTracking(async () => {
		calls++;
		return acceptToapis();
	});
	await jobs.resume();
	await jobs.resume();
	await dispatch("toapis");
	await jobs.refresh("job");
	expect(await latest()).toMatchObject({
		state: "unknown",
		quote,
		canRefresh: false,
		canSave: false,
		message: expect.stringContaining("provider history"),
	});
	expect(calls).toBe(0);
});

test("durable acknowledgement resumes automatic reads without resubmitting", async () => {
	let submits = 0;
	const readArrived = Promise.withResolvers<void>();
	const jobs = makeTracking(async (_url, request) => {
		if (request.method !== "POST") throw new Error("Only submission expected");
		submits++;
		return acceptToapis();
	});
	await jobs.resume();
	await insert();
	await dispatch("toapis");
	expect(await latest()).toMatchObject({
		state: "waiting",
		nextReadAt: start + 5_000,
		pollDeadline: start + 120_000,
		tracking: "automatic",
	});
	const restarted = await reopen(async (url, request) => {
		if (request.method === "POST") submits++;
		expect(url).toBe(`https://toapis.com/v1/images/generations/${taskId}`);
		readArrived.resolve();
		return completedToapis();
	});
	now += 5_000;
	await restarted.resume();
	await readArrived.promise;
	await restarted.refresh("job");
	expect(submits).toBe(1);
	expect(await latest()).toMatchObject({ state: "completed", tracking: "done", canSave: true });
});

test("automatic tracking starts with the durable acknowledgement even after a slow submission", async () => {
	await insert();
	makeTracking(async () => {
		now += 25_000;
		return acceptToapis();
	});
	await dispatch("toapis");
	expect(await latest()).toMatchObject({ pollDeadline: now + imageJobPollingWindowMs });
	const restarted = await reopen(async () => Response.json({ id: taskId, status: "queued" }));
	now = start + 125_000;
	await restarted.resume();
	expect(await latest()).toMatchObject({ tracking: "automatic", pollDeadline: start + 145_000 });
});

test("Retry-After survives restart, blocks Refresh and Save, and permits one shared later read", async () => {
	let reads = 0;
	const read: CheckFetch = async (_url, request) => {
		if (request.method === "POST") return acceptToapis();
		reads++;
		if (reads === 2) return new Response(null, { status: 429, headers: { "Retry-After": "180" } });
		return completedToapis();
	};
	const jobs = makeTracking(read);
	await jobs.resume();
	await insert();
	await dispatch("toapis");
	await jobs.refresh("job");
	expect(reads).toBe(0);
	now += 5_000;
	await jobs.refresh("job");
	now += 5_000;
	expect(await jobs.resultUrl("job")).toBeNull();
	expect(await latest()).toMatchObject({
		state: "completed",
		nextReadAt: now + 180_000,
		canSave: true,
		billing: { status: "settled", credits: "1.007", usd: "0.0215" },
	});
	const restarted = await reopen(read);
	await restarted.resume();
	await Promise.all([restarted.refresh("job"), restarted.resultUrl("job")]);
	expect(reads).toBe(2);
	now += 180_000;
	const [, url] = await Promise.all([restarted.refresh("job"), restarted.resultUrl("job")]);
	expect(reads).toBe(3);
	expect(url).toBe(signedUrl);
	const rows = await installation.use((db) => db.all(sql`SELECT * FROM image_job`));
	const serialized = JSON.stringify([rows, await restarted.list()]);
	for (const privateValue of [credential, prompt, signedUrl])
		expect(serialized).not.toContain(privateValue);
	expect(await restarted.list()).not.toEqual(
		expect.arrayContaining([expect.objectContaining({ task_id: taskId })]),
	);
});

test("the persisted automatic deadline leaves a manual read on the original task", async () => {
	let reads = 0;
	const read: CheckFetch = async (_url, request) => {
		if (request.method === "POST") return acceptToapis();
		reads++;
		return Response.json({ id: taskId, status: "in_progress" });
	};
	const jobs = makeTracking(read);
	await jobs.resume();
	await insert();
	await dispatch("toapis");
	const restarted = await reopen(read);
	now += 120_000;
	await restarted.resume();
	expect(await latest()).toMatchObject({ tracking: "manual", canRefresh: true });
	expect(reads).toBe(0);
	await restarted.refresh("job");
	expect(reads).toBe(1);
	expect(await latest()).toMatchObject({ tracking: "manual", state: "running" });
});

test("unknown status and authorization pause reads while keeping the last provider state", async () => {
	const responses = [
		Response.json({ id: taskId, status: "in_progress" }),
		Response.json({ id: taskId, status: "private-unsupported-sentinel" }),
		new Response(null, { status: 401 }),
	];
	let reads = 0;
	const jobs = makeTracking(async (_url, request) =>
		request.method === "POST" ? acceptToapis() : (responses[reads++] ?? completedToapis()),
	);
	await jobs.resume();
	await insert();
	await dispatch("toapis");
	now += 5_000;
	await jobs.refresh("job");
	now += 5_000;
	await jobs.refresh("job");
	expect(await latest()).toMatchObject({ tracking: "paused", state: "running", canRefresh: true });
	expect(JSON.stringify(await latest())).not.toContain("private-unsupported-sentinel");
	now += 5_000;
	await jobs.refresh("job");
	expect(await latest()).toMatchObject({ tracking: "paused", state: "running", canRefresh: true });
	expect(await jobs.needsCredential("toapis")).toBe(true);
	await installation.use((db) =>
		db.run(sql`UPDATE provider_credential SET revision=2
		WHERE provider='toapis'`),
	);
	now += 5_000;
	await jobs.refresh("job");
	expect(reads).toBe(3);
	expect(await latest()).toMatchObject({
		tracking: "paused",
		state: "running",
		canRefresh: false,
		message: expect.stringContaining("original API key"),
	});
	expect(await jobs.needsCredential("toapis")).toBe(false);
});

test("Poyo wallet comparison stays separate from task credits and omits account details", async () => {
	let balances = 0;
	const jobs = makeTracking(async (url, request) => {
		if (url.endsWith("/user/balance")) {
			return Response.json({
				code: 200,
				data: {
					credits_amount: ++balances === 1 ? 42.125 : 40,
					email: "account-sentinel@example.org",
				},
			});
		}
		if (request.method === "POST") return Response.json({ code: 200, data: { task_id: taskId } });
		return Response.json({
			code: 200,
			data: {
				task_id: taskId,
				status: "finished",
				credits_amount: 1.5,
				files: [{ file_type: "image", file_url: signedUrl }],
			},
		});
	});
	await jobs.resume();
	await insert("job", "poyo");
	await dispatch("poyo");
	now += 2_000;
	await jobs.refresh("job");
	expect(balances).toBe(2);
	expect(await latest()).toMatchObject({
		state: "completed",
		billing: { status: "reported", credits: "1.5" },
		wallet: { status: "observed", before: "42.125", after: "40", delta: "-2.125" },
	});
	const rows = await installation.use((db) => db.all(sql`SELECT * FROM image_job`));
	expect(JSON.stringify(rows)).not.toContain("account-sentinel");
});

test("overlapping Poyo jobs permanently withhold the wallet comparison across restart", async () => {
	let submitted = 0;
	const read: CheckFetch = async (url, request) => {
		if (url.endsWith("/user/balance"))
			return Response.json({ code: 200, data: { credits_amount: 20 } });
		if (request.method === "POST")
			return Response.json({ code: 200, data: { task_id: `task-${++submitted}` } });
		return Response.json({
			code: 200,
			data: {
				task_id: url.split("/").at(-1),
				status: "failed",
				error_message: "private-account-input",
			},
		});
	};
	const jobs = makeTracking(read);
	await jobs.resume();
	await insert("first", "poyo");
	await dispatch("poyo", "first");
	await insert("second", "poyo");
	await dispatch("poyo", "second");
	const restarted = await reopen(read);
	await restarted.resume();
	now += 2_000;
	await restarted.refresh("first");
	await restarted.refresh("second");
	for (const id of ["first", "second"]) {
		const job = await latest(id);
		expect(job).toMatchObject({
			state: "failed",
			wallet: { status: "unavailable", reason: "overlap" },
		});
		expect(JSON.stringify(job)).not.toContain("private-account-input");
	}
	expect(submitted).toBe(2);
});

test("a missing Poyo balance does not block a verified rejection, and an uncertain job has no after-read", async () => {
	let submits = 0;
	let balances = 0;
	const jobs = makeTracking(async (_url, request) => {
		if (request.method === "GET") {
			balances++;
			return new Response(null, { status: 503 });
		}
		if (++submits === 1)
			return Response.json({
				code: 400,
				error: { type: "invalid_request_error", message: "private-echo" },
			});
		return new Response(null, { status: 502 });
	});
	await jobs.resume();
	await insert("one", "poyo");
	await dispatch("poyo", "one");
	await insert("two", "poyo");
	await dispatch("poyo", "two");
	expect(submits).toBe(2);
	expect(balances).toBe(3);
	expect(await latest("one")).toMatchObject({
		state: "rejected",
		wallet: { status: "unavailable", reason: "missing" },
	});
	expect(await latest("two")).toMatchObject({
		state: "unknown",
		wallet: { status: "unavailable", reason: "uncertain" },
	});
});

test("temporary errors double the read interval and honor an absolute Retry-After", async () => {
	let reads = 0;
	const retryAt = start + 75_000;
	const jobs = makeTracking(async (_url, request) => {
		if (request.method === "POST") return acceptToapis();
		const headers = ++reads === 2 ? { "Retry-After": new Date(retryAt).toUTCString() } : undefined;
		return new Response(null, { status: 503, headers });
	});
	await jobs.resume();
	await insert();
	await dispatch("toapis");
	now = start + 5_000;
	await jobs.refresh("job");
	expect(await latest()).toMatchObject({ tracking: "automatic", nextReadAt: now + 10_000 });
	now += 10_000;
	await jobs.refresh("job");
	expect(await latest()).toMatchObject({ state: "waiting", nextReadAt: retryAt });
	now += 20_000;
	await jobs.refresh("job");
	expect(reads).toBe(2);
});

test("completion and billing survive an expired result and a later incomplete observation", async () => {
	let reads = 0;
	const jobs = makeTracking(async (_url, request) => {
		if (request.method === "POST") return acceptToapis();
		const first = ++reads === 1;
		return Response.json({
			id: taskId,
			status: "completed",
			...(first && {
				expires_at: start / 1_000,
				billing: { status: "settled", credits: "15.0002", cost_usd: "0.012" },
			}),
			result: { data: [{ url: signedUrl }] },
		});
	});
	await jobs.resume();
	await insert();
	await dispatch("toapis");
	now += 5_000;
	await jobs.refresh("job");
	now += 5_000;
	expect(await jobs.resultUrl("job")).toBeNull();
	expect(reads).toBe(2);
	expect(await latest()).toMatchObject({
		state: "completed",
		expiresAt: start,
		billing: { status: "settled", credits: "15.0002", usd: "0.012" },
	});
});

test("the claimed key can dispatch once even if Settings changes before the generation POST", async () => {
	let submits = 0;
	let statusReads = 0;
	const jobs = makeTracking(async (url, request) => {
		expect(new Headers(request.headers).get("Authorization")).toBe(`Bearer ${credential}`);
		if (url.endsWith("/user/balance")) {
			await installation.use((db) =>
				db.run(sql`UPDATE provider_credential SET revision=2 WHERE provider='poyo'`),
			);
			return Response.json({ code: 200, data: { credits_amount: 50 } });
		}
		if (request.method === "POST") {
			submits++;
			return Response.json({ code: 200, data: { task_id: taskId } });
		}
		statusReads++;
		return new Response(null, { status: 503 });
	});
	await jobs.resume();
	await insert("job", "poyo");
	await Promise.all([dispatch("poyo"), dispatch("poyo")]);
	now += 2_000;
	await jobs.refresh("job");
	expect(submits).toBe(1);
	expect(statusReads).toBe(0);
	expect(await latest()).toMatchObject({ state: "waiting", tracking: "paused" });
});

test("startup on a second handle preserves a live dispatch's later acknowledgement", async () => {
	let submits = 0;
	let reads = 0;
	const sent = Promise.withResolvers<void>();
	const accepted = Promise.withResolvers<Response>();
	const read: CheckFetch = async (_url, request) => {
		if (request.method !== "POST") {
			reads++;
			return completedToapis();
		}
		submits++;
		sent.resolve();
		return accepted.promise;
	};
	const jobs = makeTracking(read);
	await jobs.resume();
	await insert();
	const pending = dispatch("toapis");
	await sent.promise;
	const second = await openInstallation(directory);
	const recovering = createJobTracking(second, async () => credential, {
		fetch: read,
		now: () => now,
	});
	try {
		await recovering.resume();
		expect((await recovering.list())[0]?.state).toBe("unknown");
		accepted.resolve(acceptToapis());
		await pending;
		await dispatch("toapis");
		const row = await second.use((db) =>
			db.get<{ task_id: string }>(sql`SELECT task_id FROM image_job WHERE id='job'`),
		);
		expect(row?.task_id).toBe(taskId);
		expect((await recovering.list())[0]?.state).toBe("waiting");
		now += 5_000;
		await Promise.all([jobs.refresh("job"), recovering.refresh("job")]);
		expect((await recovering.list())[0]?.state).toBe("completed");
		expect(reads).toBe(1);
		expect(submits).toBe(1);
	} finally {
		accepted.resolve(acceptToapis());
		await pending;
		recovering.close();
		await second.close();
	}
});

test("Poyo wallet windows can overlap across key replacements", async () => {
	let submitted = 0;
	const jobs = makeTracking(async (url, request) => {
		if (url.endsWith("/user/balance")) {
			return Response.json({ code: 200, data: { credits_amount: 50 - submitted } });
		}
		if (request.method === "POST") {
			return Response.json({ code: 200, data: { task_id: `task-${++submitted}` } });
		}
		return Response.json({
			code: 200,
			data: {
				task_id: url.split("/").at(-1),
				status: "finished",
				credits_amount: 1,
			},
		});
	});
	await jobs.resume();
	await insert("first", "poyo");
	await dispatch("poyo", "first");
	await installation.use((db) =>
		db.run(sql`UPDATE provider_credential SET revision=2 WHERE provider='poyo'`),
	);
	await insert("second", "poyo");
	await installation.use((db) => db.run(sql`UPDATE image_job SET revision=2 WHERE id='second'`));
	await dispatch("poyo", "second");
	now += 2_000;
	await jobs.refresh("second");
	expect(await latest("second")).toMatchObject({
		state: "completed",
		wallet: { status: "unavailable", reason: "overlap" },
	});
});

test("a prior ambiguous Poyo dispatch can overlap a later wallet interval", async () => {
	let submitted = 0;
	const read: CheckFetch = async (url, request) => {
		if (url.endsWith("/user/balance")) {
			return Response.json({ code: 200, data: { credits_amount: 50 - submitted } });
		}
		if (request.method === "POST") {
			return ++submitted === 1
				? new Response(null, { status: 502 })
				: Response.json({ code: 200, data: { task_id: taskId } });
		}
		return Response.json({ code: 200, data: { task_id: taskId, status: "finished" } });
	};
	const jobs = makeTracking(read);
	await jobs.resume();
	await insert("first", "poyo");
	await dispatch("poyo", "first");
	const restarted = await reopen(read);
	await restarted.resume();
	now += imageJobPollingWindowMs;
	await insert("second", "poyo");
	await dispatch("poyo", "second");
	now += 2_000;
	await restarted.refresh("second");
	expect(await latest("first")).toMatchObject({
		state: "unknown",
		wallet: { status: "unavailable", reason: "uncertain" },
	});
	expect(await latest("second")).toMatchObject({
		state: "completed",
		wallet: { status: "unavailable", reason: "overlap" },
	});
});

test("a second startup preserves a terminal job's in-flight wallet interval", async () => {
	let balances = 0;
	let submits = 0;
	const readingAfter = Promise.withResolvers<void>();
	const after = Promise.withResolvers<Response>();
	const balance = (credits: number) =>
		Response.json({ code: 200, data: { credits_amount: credits } });
	const read: CheckFetch = async (url, request) => {
		if (url.endsWith("/user/balance")) {
			balances++;
			if (balances === 2) {
				readingAfter.resolve();
				return after.promise;
			}
			return balance(30 - submits);
		}
		if (request.method === "POST")
			return Response.json({ code: 200, data: { task_id: `task-${++submits}` } });
		return Response.json({ code: 200, data: { task_id: "task-1", status: "finished" } });
	};
	const jobs = makeTracking(read);
	await jobs.resume();
	await insert("first", "poyo");
	await dispatch("poyo", "first");
	now += 2_000;
	const completing = jobs.refresh("first");
	await readingAfter.promise;
	const second = await openInstallation(directory);
	const recovering = createJobTracking(second, async () => credential, {
		fetch: read,
		now: () => now,
	});
	try {
		await recovering.resume();
		await insert("second", "poyo");
		await dispatch("poyo", "second");
		after.resolve(balance(28));
		await completing;
		expect(await latest("first")).toMatchObject({
			state: "completed",
			wallet: { status: "unavailable", reason: "overlap" },
		});
	} finally {
		after.resolve(balance(28));
		await completing;
		recovering.close();
		await second.close();
	}
});
