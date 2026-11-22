import { afterEach, beforeEach, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { sql } from "drizzle-orm";
import { createOwnerDirectory } from "../../../../../tests/fixtures/owner-directory";
import { referencePng } from "../../../../../tests/fixtures/reference-image";
import {
	buildSeedreamRequest,
	createSeedreamDraft,
	validateSeedreamDraft,
} from "../../../shared/image-studio/seedream";
import {
	buildZImageRequest,
	createZImageDraft,
	validateZImageDraft,
} from "../../../shared/image-studio/z-image";
import type { ProviderId } from "../../../shared/providers/connections";
import { imageJobPollingWindowMs } from "../../db/image-job-schema";
import { imageJobStore } from "../../db/image-job-store";
import { openInstallation } from "../../db/installation";
import { providerStore } from "../../db/provider-store";
import { openRuntimeInstallation, type RuntimeInstallation } from "../../db/runtime-installation";
import { videoJobPollingWindowMs } from "../../db/video-schema";
import type { CheckFetch } from "../../providers/connection-check";
import { createGallery } from "../gallery/gallery";
import { createJobTracking } from "./tracking";

const start = 1_799_000_000_000;
const taskId = "task-fixture-542";
const signedUrl = "https://cdn.example.net/media/sample.png?secret=signed-result-sentinel";
const referenceUrl =
	"https://reference-sentinel.example.net/reference-path.png?sig=reference-query#reference-fragment";
const prompt = "A vibrant orange prompt-sentinel";
const quote = { status: "unknown", reason: "missing-feed", maxAttempts: 1 } as const;
const credential = "key-sentinel";
let now: number;
let directory: string;
let installation: RuntimeInstallation;
let tracker: ReturnType<typeof createJobTracking> | undefined;

beforeEach(async () => {
	now = start;
	directory = await createOwnerDirectory();
	installation = await openRuntimeInstallation(directory);
	const store = providerStore(installation);
	for (const provider of ["poyo", "toapis"] as const)
		await store.save(provider, credential, now, true, 0);
});

afterEach(async () => {
	tracker?.close();
	await installation.close();
	await rm(directory, { recursive: true, force: true });
});

const latest = async (id = "job") => (await tracker?.list())?.find((job) => job.id === id);
const insert = (
	id = "job",
	provider: ProviderId = "toapis",
	model = provider === "poyo" ? "seedream-5.5" : "doubao-seedream-5-5",
	revision = 1,
) =>
	installation.use((db) =>
		db.run(sql`INSERT INTO image_job (id,binding,provider,revision,quote,state,created_at,model,poll_deadline)
			VALUES (${id},'binding',${provider},${revision},${JSON.stringify(quote)},'submitting',${now},
				${model},${now + imageJobPollingWindowMs})`),
	);

function makeTracking(read: CheckFetch) {
	tracker = createJobTracking(installation, providerStore(installation), {
		fetch: read,
		now: () => now,
		random: () => 0,
	});
	return tracker;
}

function dispatch(provider: ProviderId, id = "job", reference?: string) {
	const draft = createSeedreamDraft(provider, reference ? "edit" : "generate");
	const validation = validateSeedreamDraft({
		...draft,
		prompt,
		references: reference
			? [{ kind: "url", url: reference, hostname: new URL(reference).hostname }]
			: [],
	});
	if (!validation.ok || !tracker) throw new Error("Invalid fixture");
	return tracker.dispatch(
		id,
		provider,
		credential,
		buildSeedreamRequest(validation.input, (reference) =>
			reference.kind === "url" ? reference.url : "",
		),
	);
}

async function reopen(read: CheckFetch) {
	tracker?.close();
	await installation.close();
	installation = await openRuntimeInstallation(directory);
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

test.each([
	[
		"failed",
		"reference_media_unreadable",
		"The provider could not read one or more reference images.",
	],
	["failed", "private-unknown-reason", "The provider reported that the job failed."],
	["completed", null, null],
] as const)(
	"ToAPIs edit stores only bounded status data after %s (%s) and restart",
	async (state, reason, message) => {
		const echo = { prompt, input_media_errors: [{ message: referenceUrl }] };
		let submits = 0;
		let reads = 0;
		const read: CheckFetch = async (url, request) => {
			if (request.method === "POST") {
				submits++;
				expect(url).toBe("https://toapis.com/v1/images/generations");
				expect(JSON.parse(String(request.body))).toMatchObject({
					prompt,
					image_urls: [referenceUrl],
				});
				return Response.json({ id: taskId, status: "pending", metadata: echo });
			}
			reads++;
			expect(url).toBe(`https://toapis.com/v1/images/generations/${taskId}`);
			return Response.json(
				state === "failed"
					? {
							id: taskId,
							status: state,
							error: { ...echo, reason: reads === 1 ? reason : undefined },
						}
					: { id: taskId, status: state, metadata: echo, result: { data: [{ url: signedUrl }] } },
			);
		};
		const jobs = makeTracking(read);
		await jobs.resume();
		await insert();
		await dispatch("toapis", "job", referenceUrl);
		now += 5_000;
		await jobs.refresh("job");
		expect(await latest()).toMatchObject({ state, message });
		const restarted = await reopen(read);
		await restarted.resume();
		expect(await latest()).toMatchObject({ state, message });
		now += 5_000;
		if (state === "completed") expect(await restarted.resultUrl("job")).toBe(signedUrl);
		else await restarted.refresh("job");
		expect(await latest()).toMatchObject({ state, message });
		expect(submits).toBe(1);
		expect(reads).toBe(2);
		const rows = await installation.use((db) => db.all(sql`SELECT * FROM image_job`));
		expect(rows).toMatchObject([
			{ failure_reason: reason === "reference_media_unreadable" ? reason : null },
		]);
		const serialized = JSON.stringify([rows, await restarted.list()]);
		for (const privateValue of [
			credential,
			prompt,
			signedUrl,
			"reference-sentinel",
			"reference-path",
			"reference-query",
			"reference-fragment",
			"private-unknown-reason",
		])
			expect(serialized).not.toContain(privateValue);
	},
);

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

test("a successful completed status can be saved after its normal read interval", async () => {
	const jobs = makeTracking(async (_url, request) => {
		if (request.method === "POST") return acceptToapis();
		const completed = completedToapis();
		completed.headers.set("Retry-After", "99999999999");
		return completed;
	});
	await jobs.resume();
	await insert();
	await dispatch("toapis");
	now += 5_000;
	await jobs.refresh("job");
	expect(await latest()).toMatchObject({ state: "completed", nextReadAt: now + 5_000 });
	now += 5_000;
	expect(await jobs.resultUrl("job")).toBe(signedUrl);
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
	const recovering = createJobTracking(second, providerStore(second), {
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
	await providerStore(installation).save("poyo", credential, now, true, 1);
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
	const recovering = createJobTracking(second, providerStore(second), {
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

test.each(["generate", "edit"] as const)(
	"Z-Image %s retries a failed Save on the same task after an unresolved Seedream submission",
	async (operation) => {
		const posts: unknown[] = [];
		const statusUrls: string[] = [];
		const read: CheckFetch = async (url, init) => {
			if (url.endsWith("/user/balance"))
				return Response.json({ code: 200, data: { credits_amount: 61 - posts.length } });
			if (init.method === "POST") {
				posts.push(JSON.parse(String(init.body)));
				return posts.length === 1
					? new Response(null, { status: 502 })
					: Response.json({ code: 200, data: { task_id: taskId } });
			}
			statusUrls.push(url);
			return Response.json({
				code: 200,
				data: {
					task_id: taskId,
					status: "finished",
					credits_amount: 2,
					files: [{ file_type: "image", file_url: signedUrl }],
				},
			});
		};
		const jobs = makeTracking(read);
		await insert("uncertain", "poyo");
		await dispatch("poyo", "uncertain");
		expect(await latest("uncertain")).toMatchObject({ state: "unknown" });
		await providerStore(installation).save("poyo", "replacement-key", now, false, 1);
		await insert("z-job", "poyo", "z-image", 2);
		const validated = validateZImageDraft({
			...createZImageDraft(operation, prompt),
			references: operation === "edit" ? [{ kind: "url", url: referenceUrl }] : [],
		});
		if (!validated.ok) throw new Error("Invalid fixture");
		const request = buildZImageRequest(validated.input);
		await Promise.all([
			jobs.dispatch("z-job", "poyo", "replacement-key", request),
			jobs.dispatch("z-job", "poyo", "replacement-key", request),
		]);
		now += 2000;
		await jobs.refresh("z-job");
		expect(await latest("z-job")).toMatchObject({
			state: "completed",
			model: "z-image",
			billing: { status: "reported", credits: "2" },
			wallet: { status: "unavailable", reason: "overlap" },
		});
		expect(await jobs.needsCredential("poyo")).toBe(true);
		expect(await providerStore(installation).remove("poyo", true)).toBe("job-warning");
		const downloads: string[] = [];
		const gallery = createGallery(installation, jobs.resultUrl, async (url) => {
			downloads.push(url);
			if (downloads.length === 1) throw new Error("Expired link");
			return referencePng;
		});
		now += 2000;
		expect(await gallery.save("z-job")).toBe(false);
		expect(await latest("z-job")).toMatchObject({ state: "completed", canSave: true });
		now += 2000;
		expect(await gallery.save("z-job")).toBe(true);
		expect(downloads).toEqual([signedUrl, signedUrl]);
		expect(statusUrls).toEqual(Array(3).fill(`https://api.poyo.ai/api/generate/status/${taskId}`));
		const restarted = await reopen(read);
		await restarted.resume();
		await providerStore(installation).remove("poyo");
		expect((await createGallery(installation, restarted.resultUrl).read("z-job"))?.bytes).toEqual(
			referencePng,
		);
		expect(posts).toHaveLength(2);
		expect(posts[1]).toEqual(request.body);
		const rows = await installation.use((db) => db.all(sql`SELECT * FROM image_job`));
		for (const value of [prompt, referenceUrl, signedUrl, credential, "replacement-key"])
			expect(JSON.stringify(rows)).not.toContain(value);
	},
);

// A Poyo video claim as Video Queue writes it: no correlation ID and a NULL video deadline.
async function insertH3(id = "h3", revision = 1, state = "submitting") {
	await installation.use((db) =>
		db.run(sql`INSERT INTO image_job (id,binding,provider,revision,quote,state,created_at,model,operation,poll_deadline,video_terms)
			VALUES (${id},'binding','poyo',${revision},${JSON.stringify(quote)},${state},${now},'h3-max','text-to-video',
				${now + imageJobPollingWindowMs},'["terms"]')`),
	);
}

function h3Reader(reads: string[], status = "running") {
	return (async (url: string) => {
		reads.push(url);
		return Response.json({ code: 200, data: { task_id: "h3_task", status } });
	}) as CheckFetch;
}

function manualTimers() {
	const due: (() => Promise<void>)[] = [];
	return {
		due,
		scheduleRead: (read: () => Promise<void>) => {
			due.push(read);
			return () => {};
		},
		async fire() {
			const read = due.pop();
			if (!read) throw new Error("No scheduled read.");
			await read();
		},
	};
}

test("accepted H3 ack records; automatic polling continues past 120 s and stops at 600 s", async () => {
	// A balance-only Poyo key: Seedream access is not required to poll H3.
	await providerStore(installation).save("poyo", credential, now, false, 1);
	await insertH3("h3", 2);
	const reads: string[] = [];
	const timers = manualTimers();
	tracker = createJobTracking(installation, providerStore(installation), {
		fetch: h3Reader(reads),
		now: () => now,
		random: () => 0,
		scheduleRead: timers.scheduleRead,
	});
	const store = imageJobStore(installation);
	expect(await store.beginDispatch("h3", "poyo", now)).toBeTruthy();
	const recorded = await store.recordSubmission(
		"h3",
		{ kind: "accepted", taskId: "h3_task" },
		now,
		2_000,
	);
	expect(recorded).toMatchObject({
		state: "waiting",
		task_id: "h3_task",
		video_poll_deadline: null,
	});
	const acknowledged = now;
	await tracker.resume();
	now = acknowledged + 130_000;
	await timers.fire();
	expect(reads).toEqual(["https://api.poyo.ai/api/generate/status/h3_task"]);
	expect(await latest("h3")).toMatchObject({
		state: "running",
		tracking: "automatic",
		pollDeadline: acknowledged + videoJobPollingWindowMs,
	});
	now = acknowledged + videoJobPollingWindowMs;
	await timers.fire().catch(() => {});
	expect(reads).toHaveLength(1);
	expect(await latest("h3")).toMatchObject({ tracking: "manual", canRefresh: true });
	await tracker.refresh("h3");
	expect(reads).toHaveLength(2);
});

test("replacing the Poyo key pauses H3 reads and discards a read in flight", async () => {
	await insertH3();
	const store = imageJobStore(installation);
	await store.beginDispatch("h3", "poyo", now);
	await store.recordSubmission("h3", { kind: "accepted", taskId: "h3_task" }, now, 2_000);
	const settings = providerStore(installation);
	let replace = true;
	makeTracking(async () => {
		if (replace) {
			replace = false;
			await settings.save("poyo", "replacement", now, true, 1);
		}
		return Response.json({ code: 200, data: { task_id: "h3_task", status: "failed" } });
	});
	now += 2_000;
	await tracker?.refresh("h3");
	expect(await store.get("h3")).toMatchObject({ state: "waiting", read_token: expect.any(String) });
	now += 60_000;
	await tracker?.refresh("h3");
	expect(await latest("h3")).toMatchObject({
		state: "waiting",
		message: expect.stringContaining("original API key"),
	});
});

test("unknown Poyo job raises no Settings warning; active and unsaved H3 jobs do", async () => {
	const settings = providerStore(installation);
	await settings.save("poyo", credential, now, false, 1);
	await insertH3("lost", 2, "unknown");
	const store = imageJobStore(installation);
	expect(await store.needsCredential("poyo")).toBe(false);
	await insertH3("active", 2, "running");
	expect(await store.needsCredential("poyo")).toBe(true);
	await installation.use((db) =>
		db.run(sql`UPDATE image_job SET state='completed' WHERE id='active'`),
	);
	expect(await store.needsCredential("poyo")).toBe(true);
});

test("unresolved Poyo spend marks a new wallet overlap", async () => {
	const read: CheckFetch = async (url, request) => {
		if (url.endsWith("/user/balance"))
			return Response.json({ code: 200, data: { credits_amount: 50 } });
		if (request.method === "POST") return Response.json({ code: 200, data: { task_id: taskId } });
		return Response.json({ code: 200, data: { task_id: taskId, status: "finished" } });
	};
	// A Poyo H3 claim interrupted before dispatch: restart leaves it uncertain with no open wallet.
	await insertH3("lost");
	const jobs = makeTracking(read);
	await jobs.resume();
	expect(await imageJobStore(installation).get("lost")).toMatchObject({
		state: "unknown",
		wallet_open: 0,
	});
	// A later interval on a replacement key still cannot attribute the movement.
	await providerStore(installation).save("poyo", credential, now, true, 1);
	await insert("next", "poyo", "seedream-5.5", 2);
	await dispatch("poyo", "next");
	now += 2_000;
	await jobs.refresh("next");
	expect(await latest("next")).toMatchObject({
		state: "completed",
		wallet: { status: "unavailable", reason: "overlap" },
	});
	expect(await latest("lost")).toMatchObject({
		wallet: { status: "unavailable", reason: "uncertain" },
	});
});

const h3Target = {
	provider: "poyo",
	body: {
		model: "h3-max",
		input: {
			prompt,
			duration: 5,
			resolution: "768p",
			aspect_ratio: "16:9",
			enable_safety_checker: false,
		},
	},
} as const;

test.each(["image", "video"] as const)(
	"a job starting during a %s after-read withholds both comparisons",
	async (first) => {
		let hold: PromiseWithResolvers<void> | undefined;
		const reading = Promise.withResolvers<void>();
		const jobs = makeTracking(async (url, request) => {
			if (url.endsWith("/user/balance")) {
				if (hold) {
					reading.resolve();
					await hold.promise;
				}
				return Response.json({ code: 200, data: { credits_amount: 40 } });
			}
			if (request.method === "POST") {
				const body = JSON.parse(String(request.body));
				return Response.json({ code: 200, data: { task_id: body.model.replace(/\W/g, "_") } });
			}
			const id = url.split("/").at(-1);
			return Response.json({
				code: 200,
				data: { task_id: id, status: "finished", credits_amount: 1 },
			});
		});
		await insert("image", "poyo");
		await insertH3("video");
		const start = async (kind: "image" | "video") =>
			kind === "image"
				? dispatch("poyo", "image")
				: jobs.dispatchVideo("video", credential, h3Target);
		const second = first === "image" ? "video" : "image";
		await start(first);
		now += 2_000;
		hold = Promise.withResolvers<void>();
		const afterRead = jobs.refresh(first);
		await reading.promise;
		const release = hold;
		hold = undefined;
		await start(second);
		release.resolve();
		await afterRead;
		now += 2_000;
		await jobs.refresh(second);
		for (const id of ["image", "video"])
			expect(await latest(id)).toMatchObject({
				state: "completed",
				wallet: { status: "unavailable", reason: "overlap" },
			});
	},
);

test("a key replaced after the claim leaves the H3 job unsent with no POST", async () => {
	let posts = 0;
	const jobs = makeTracking(async (url, request) => {
		if (url.endsWith("/user/balance")) {
			await providerStore(installation).save("poyo", "replacement", now, true, 1);
			return Response.json({ code: 200, data: { credits_amount: 40 } });
		}
		if (request.method === "POST") posts++;
		return Response.json({ code: 200, data: { task_id: "x" } });
	});
	await insertH3("video");
	await jobs.dispatchVideo("video", credential, h3Target);
	expect(posts).toBe(0);
	expect(await latest("video")).toMatchObject({
		state: "unsent",
		skipped: "interrupted",
		wallet: null,
	});
});
