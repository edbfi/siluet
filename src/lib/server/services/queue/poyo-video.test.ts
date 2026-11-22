import { afterEach, beforeEach, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { sql } from "drizzle-orm";
import h3Feed from "../../../../../tests/fixtures/h3-rate.v2.json";
import { createOwnerDirectory } from "../../../../../tests/fixtures/owner-directory";
import { h3MaxOperation } from "../../../shared/media-catalog/registry";
import { decodePricingFeeds, type PricingFeeds } from "../../../shared/pricing/feeds";
import { parseVideo } from "../../../shared/video-studio/request";
import { imageJobStore } from "../../db/image-job-store";
import { type Installation, openInstallation } from "../../db/installation";
import { providerStore } from "../../db/provider-store";
import type { CheckFetch } from "../../providers/connection-check";
import { createJobTracking } from "../jobs/tracking";
import { createVideoAccess } from "../providers/video-access";
import { createVideoQueue } from "./video";

let directory: string;
let db: Installation;
let now: number;
let jobs: ReturnType<typeof createJobTracking> | undefined;
const task = "h3_task";
const clip = "https://media.example.org/h3.mp4";

beforeEach(async () => {
	directory = await createOwnerDirectory();
	db = await openInstallation(directory);
	now = Date.parse("2026-11-22T00:00:00Z");
});
afterEach(async () => {
	jobs?.close();
	await db.close();
	await rm(directory, { recursive: true, force: true });
});

function request(duration = 5, resolution = "768p", aspect_ratio = "16:9") {
	const parsed = parseVideo({
		operationKey: h3MaxOperation.key,
		count: 1,
		retryLimit: 0,
		acceptTerms: false,
		draft: { prompt: "A blue wheel turns", duration, resolution, aspect_ratio },
	});
	if (!parsed) throw new Error("Invalid H3 fixture.");
	return parsed;
}

type Calls = { posts: number; balances: number; reads: number; urls: string[] };

/** A Poyo-only studio: tracking, access and Video Queue over one installation. */
async function studio(fetch: CheckFetch, { feeds = async (): Promise<PricingFeeds> => ({}) } = {}) {
	const store = providerStore(db);
	const access = createVideoAccess(db, store);
	jobs = createJobTracking(db, store, { fetch, now: () => now, random: () => 0 });
	const tracker = jobs;
	const queue = await createVideoQueue(db, access, tracker.dispatchVideo, feeds, () => now);
	return { store, queue, jobs: tracker };
}

function poyo(calls: Calls, submit: () => Response | Promise<Response>, status?: () => Response) {
	return (async (url: string, init: RequestInit) => {
		calls.urls.push(url);
		if (url.endsWith("/api/user/balance")) {
			calls.balances++;
			return Response.json({ code: 200, data: { credits_amount: 100 - calls.posts } });
		}
		if (init.method === "POST") {
			calls.posts++;
			return submit();
		}
		calls.reads++;
		return (
			status?.() ??
			Response.json({
				code: 200,
				data: {
					task_id: task,
					status: "finished",
					credits_amount: 80,
					files: [{ file_type: "video", file_url: clip }],
				},
			})
		);
	}) as CheckFetch;
}
const calls = (): Calls => ({ posts: 0, balances: 0, reads: 0, urls: [] });
const accepted = () => Response.json({ code: 200, data: { task_id: task } });

async function reviewAndClick(
	queue: Awaited<ReturnType<typeof studio>>["queue"],
	input = request(),
) {
	const review = await queue.review("owner", input);
	return { review, click: { ...input, token: review.token, acceptTerms: true } };
}

test("replay after restart sends one POST", async () => {
	const seen = calls();
	const first = await studio(
		poyo(seen, () => {
			throw new Error("lost acknowledgement");
		}),
	);
	await first.store.save("poyo", "balance-only", now, false, 0);
	const { review, click } = await reviewAndClick(first.queue);
	expect(review.blockers).toEqual([]);
	expect(review.quote).toMatchObject({ status: "unknown" });
	const result = await first.queue.submit("owner", click);
	expect(result).toHaveProperty("jobId");
	expect(seen.posts).toBe(1);
	expect(await first.jobs.list()).toMatchObject([
		{ provider: "poyo", model: "h3-max", state: "unknown", canLookup: false },
	]);

	jobs?.close();
	await db.close();
	db = await openInstallation(directory);
	// After restart and feed expiry, the claimed Review still replays.
	now += 31 * 86_400_000;
	const restarted = await studio(poyo(seen, accepted));
	await restarted.jobs.resume();
	expect(await restarted.queue.submit("owner", click)).toEqual(result);
	await restarted.store.save("poyo", "replacement", now, false, 1);
	expect(await restarted.queue.submit("owner", click)).toEqual(result);
	expect(seen.posts).toBe(1);
	expect(seen.urls.every((url) => url.startsWith("https://api.poyo.ai/"))).toBe(true);
	expect((await imageJobStore(db).list())[0]).toMatchObject({
		provider: "poyo",
		business_id: null,
		video_poll_deadline: null,
		operation: "text-to-video",
	});
});

const gate = (until: number) =>
	db.use((c) => c.run(sql`UPDATE provider_gate SET submit_after=${until} WHERE provider='poyo'`));

test("late cooldown → unsent, 0 POST, 0 after-balance", async () => {
	const seen = calls();
	let closeGate = true;
	const fetch = poyo(seen, accepted);
	const {
		store,
		queue,
		jobs: tracker,
	} = await studio(async (url, init) => {
		// The gate closes while the before-balance read is in flight.
		if (url.endsWith("/api/user/balance") && closeGate) {
			closeGate = false;
			await gate(now + 60_000);
		}
		return fetch(url, init);
	});
	await store.save("poyo", "balance-only", now, false, 0);
	const { click } = await reviewAndClick(queue);
	const result = await queue.submit("owner", click);
	expect(await queue.submit("owner", click)).toEqual(result);
	expect([seen.posts, seen.balances]).toEqual([0, 1]);
	expect(await tracker.list()).toMatchObject([
		{ state: "unsent", skipped: "cooldown", wallet: null, canLookup: false },
	]);
	expect((await imageJobStore(db).list())[0]).toMatchObject({ wallet_open: 0, wallet_after: null });
});

test("the claim honours a closed Poyo gate with 0 POST and keeps the Review token", async () => {
	const seen = calls();
	const { store, queue } = await studio(poyo(seen, accepted));
	await store.save("poyo", "balance-only", now, false, 0);
	const { click } = await reviewAndClick(queue);
	await gate(now + 1_000);
	expect(await queue.submit("owner", click)).toEqual({ error: "cooldown", until: now + 1_000 });
	expect(seen.balances + seen.posts).toBe(0);
	await gate(0);
	expect(await queue.submit("owner", click)).toHaveProperty("jobId");
	expect(seen.posts).toBe(1);
});

test("submit 429 closes the gate and the job stays uncertain without a Settings warning", async () => {
	const seen = calls();
	const limiter = () =>
		Response.json(
			{ code: 429, error: { type: "rate_limit_error", message: "fixture" } },
			{ status: 429, headers: { "Retry-After": "60" } },
		);
	const { store, queue, jobs: tracker } = await studio(poyo(seen, limiter));
	await store.save("poyo", "balance-only", now, false, 0);
	const first = await reviewAndClick(queue);
	const result = await queue.submit("owner", first.click);
	const fresh = await reviewAndClick(queue);
	expect(await queue.submit("owner", fresh.click)).toEqual({
		error: "cooldown",
		until: now + 60_000,
	});
	expect(await queue.submit("owner", first.click)).toEqual(result);
	expect(await tracker.list()).toMatchObject([
		{
			state: "unknown",
			canLookup: false,
			wallet: { status: "unavailable", reason: "uncertain" },
			message: expect.stringContaining("provider history"),
		},
	]);
	expect(await tracker.needsCredential("poyo")).toBe(false);
	expect(seen.posts).toBe(1);
});

test("403 permission refusal keeps the key and discards an after-read from a replaced revision", async () => {
	const seen = calls();
	const sampling = Promise.withResolvers<void>();
	const finish = Promise.withResolvers<void>();
	const fetch = poyo(seen, () =>
		Response.json(
			{ code: 403, error: { type: "permission_denied_error", message: "sensitive prompt echo" } },
			{ status: 403 },
		),
	);
	const {
		store,
		queue,
		jobs: tracker,
	} = await studio(async (url, init) => {
		if (url.endsWith("/api/user/balance") && seen.balances === 1) {
			seen.balances++;
			sampling.resolve();
			await finish.promise;
			return Response.json({ code: 200, data: { credits_amount: 90, email: "a@example.test" } });
		}
		return fetch(url, init);
	});
	await store.save("poyo", "first", now, false, 0);
	const { click } = await reviewAndClick(queue);
	const queued = queue.submit("owner", click);
	await sampling.promise;
	try {
		expect(await store.credential("poyo", 1, "poyo-balance")).toEqual({
			key: "first",
			revision: 1,
		});
		await store.save("poyo", "replacement", now, false, 1);
	} finally {
		finish.resolve();
	}
	await queued;
	const [job] = await imageJobStore(db).list();
	expect(job).toMatchObject({
		rejection: "permission",
		state: "rejected",
		wallet_open: 0,
		wallet_after: null,
	});
	expect(JSON.stringify(job)).not.toContain("sensitive prompt echo");
	expect(JSON.stringify(job)).not.toContain("a@example.test");
	expect(await tracker.list()).toMatchObject([
		{
			message: "Poyo.ai refused this model for this key. The saved key is unchanged.",
			wallet: { status: "unavailable", reason: "missing" },
		},
	]);
	expect(seen.balances).toBe(2);
});

test("crash before the POST and after the POST both replay without another POST", async () => {
	for (const crash of ["before", "after"] as const) {
		const seen = calls();
		const posted = Promise.withResolvers<void>();
		const never = new Promise<Response>(() => {});
		let dispatching = Promise.resolve();
		const store = providerStore(db);
		const access = createVideoAccess(db, store);
		jobs = createJobTracking(db, store, {
			fetch: poyo(seen, () => {
				posted.resolve();
				return never;
			}),
			now: () => now,
			random: () => 0,
		});
		const tracker = jobs;
		const queue = await createVideoQueue(
			db,
			access,
			async (id, key, send) => {
				if (crash === "before") return;
				dispatching = tracker.dispatchVideo(id, key, send);
				await posted.promise;
			},
			async () => ({}),
			() => now,
		);
		await store.save("poyo", `key-${crash}`, now, false, crash === "before" ? 0 : 1);
		const { click } = await reviewAndClick(queue);
		const result = await queue.submit("owner", click);
		void dispatching;
		tracker.close();
		await db.close();
		db = await openInstallation(directory);
		const restarted = await studio(poyo(seen, accepted));
		await restarted.jobs.resume();
		expect(await restarted.queue.submit("owner", click)).toEqual(result);
		const job = (await restarted.jobs.list()).find(
			(entry) => "jobId" in result && entry.id === result.jobId,
		);
		expect(job).toMatchObject({ state: "unknown", canLookup: false, canRefresh: false });
		expect(seen.posts).toBe(crash === "before" ? 0 : 1);
		jobs?.close();
	}
	expect(await imageJobStore(db).needsCredential("poyo")).toBe(false);
});

test("Poyo H3 videoResult returns a delivery, resultUrl none", async () => {
	const seen = calls();
	const { store, queue, jobs: tracker } = await studio(poyo(seen, accepted));
	await store.save("poyo", "balance-only", now, false, 0);
	const { click } = await reviewAndClick(queue);
	const result = await queue.submit("owner", click);
	if (!("jobId" in result)) throw new Error("Queue refused.");
	expect(await tracker.isVideo(result.jobId)).toBe(true);
	now += 2_000;
	await tracker.refresh(result.jobId);
	expect(await tracker.list()).toMatchObject([
		{
			state: "completed",
			canSave: true,
			billing: { status: "reported", credits: "80" },
			wallet: { status: "observed", before: "100", after: "99", delta: "-1" },
		},
	]);
	now += 5_000;
	expect(await tracker.resultUrl(result.jobId)).toBeNull();
	now += 5_000;
	expect(await tracker.videoResult(result.jobId)).toEqual({ url: clip, fallback: null });
	expect(seen.urls.filter((url) => url.includes("/status/"))).toEqual(
		Array(3).fill(`https://api.poyo.ai/api/generate/status/${task}`),
	);
});

test("P-04: observed Poyo status 429 honours Retry-After and Retry Save reads the same task after cooldown", async () => {
	const seen = calls();
	let limited = false;
	const {
		store,
		queue,
		jobs: tracker,
	} = await studio(
		poyo(seen, accepted, () =>
			limited
				? Response.json({ code: 429 }, { headers: { "Retry-After": "11" } })
				: Response.json({
						code: 200,
						data: {
							task_id: task,
							status: "finished",
							files: [{ file_type: "video", file_url: clip }],
						},
					}),
		),
	);
	await store.save("poyo", "balance-only", now, false, 0);
	const { click } = await reviewAndClick(queue);
	const result = await queue.submit("owner", click);
	if (!("jobId" in result)) throw new Error("Queue refused.");
	now += 2_000;
	await tracker.refresh(result.jobId);
	now += 5_000;
	limited = true;
	expect(await tracker.videoResult(result.jobId)).toBeNull();
	expect(await tracker.list()).toMatchObject([{ canSave: true, nextReadAt: now + 11_000 }]);
	expect(await tracker.videoResult(result.jobId)).toBeNull();
	expect(seen.reads).toBe(2);
	now += 11_000;
	limited = false;
	expect(await tracker.videoResult(result.jobId)).toEqual({ url: clip, fallback: null });
	expect(seen.reads).toBe(3);
	expect(seen.posts).toBe(1);
});

test("P-03: three H3 jobs share Poyo's two reads per second", async () => {
	const seen = calls();
	let posts = 0;
	const {
		store,
		queue,
		jobs: tracker,
	} = await studio(
		poyo(
			seen,
			() => Response.json({ code: 200, data: { task_id: `clip_${++posts}` } }),
			() =>
				Response.json({ code: 200, data: { task_id: `clip_${seen.reads}`, status: "running" } }),
		),
	);
	await store.save("poyo", "balance-only", now, false, 0);
	const ids: string[] = [];
	for (let i = 0; i < 3; i++) {
		const { click } = await reviewAndClick(queue);
		const claimed = await queue.submit("owner", click);
		if (!("jobId" in claimed)) throw new Error("Queue refused.");
		ids.push(claimed.jobId);
	}
	now += 2_000;
	await Promise.all(ids.map((id) => tracker.refresh(id)));
	expect(seen.reads).toBe(2);
	expect((await tracker.list()).filter((job) => job.nextReadAt === now + 1_000)).toHaveLength(1);
});

const knownFeeds =
	(rates: Record<string, unknown> = h3Feed.rates) =>
	async () =>
		decodePricingFeeds({ ...h3Feed, rates });

test("server Review and Queue for 5 s/768p carry one 80-credit quote", async () => {
	const seen = calls();
	const {
		store,
		queue,
		jobs: tracker,
	} = await studio(poyo(seen, accepted), {
		feeds: knownFeeds(),
	});
	await store.save("poyo", "balance-only", now, false, 0);
	const { review, click } = await reviewAndClick(queue);
	expect(review.quote).toMatchObject({
		status: "known",
		unit: "poyo_credit",
		perRequest: "80",
		revision: h3Feed.revision,
	});
	expect((await queue.review("owner", request())).token.split(".")[1]).toBe(
		review.token.split(".")[1],
	);
	expect(await queue.submit("owner", click)).toHaveProperty("jobId");
	expect(await tracker.list()).toMatchObject([{ quote: review.quote }]);
	expect((await imageJobStore(db).list())[0]).toMatchObject({ accepted_unknown: 0 });
	expect(seen.posts).toBe(1);
});

test.each([
	["withdrawn", { kind: "unavailable" }],
	["changed", { kind: "per-second-by-resolution", resolutions: { "480p": "10", "768p": "17" } }],
])("a rate %s between Review and Queue makes the Review stale with 0 POST", async (_, rate) => {
	const seen = calls();
	let rates: Record<string, unknown> = h3Feed.rates;
	const { store, queue } = await studio(poyo(seen, accepted), {
		feeds: async () => decodePricingFeeds({ ...h3Feed, rates }),
	});
	await store.save("poyo", "balance-only", now, false, 0);
	const { review, click } = await reviewAndClick(queue);
	expect(review.quote).toMatchObject({ status: "known", perRequest: "80" });
	rates = { ...h3Feed.rates, "h3-max": rate };
	expect(await queue.submit("owner", click)).toEqual({ error: "stale" });
	expect(seen.posts + seen.balances).toBe(0);
	const fresh = await reviewAndClick(queue);
	expect(fresh.review.quote.status === "known" ? fresh.review.quote.perRequest : "unknown").toBe(
		rate.kind === "unavailable" ? "unknown" : "85",
	);
	expect(await queue.submit("owner", fresh.click)).toHaveProperty("jobId");
	expect(seen.posts).toBe(1);
});

test("without an h3-max rate the server issues unknown terms that queue once only with consent", async () => {
	const seen = calls();
	const { "h3-max": _, ...withoutH3 } = h3Feed.rates;
	const { store, queue } = await studio(poyo(seen, accepted), { feeds: knownFeeds(withoutH3) });
	await store.save("poyo", "balance-only", now, false, 0);
	const { review, click } = await reviewAndClick(queue);
	expect(review.quote).toEqual({ status: "unknown", reason: "rate-unavailable", maxAttempts: 1 });
	expect(await queue.submit("owner", { ...click, acceptTerms: false })).toEqual({
		error: "invalid",
	});
	expect(seen.posts + seen.balances).toBe(0);
	const result = await queue.submit("owner", click);
	expect(await queue.submit("owner", click)).toEqual(result);
	expect((await imageJobStore(db).list())[0]).toMatchObject({ accepted_unknown: 1 });
	expect(seen.posts).toBe(1);
});

test("P-01: racing claims of one Review return one job and send one POST", async () => {
	const seen = calls();
	const { store, queue } = await studio(poyo(seen, accepted));
	await store.save("poyo", "balance-only", now, false, 0);
	const { click } = await reviewAndClick(queue);
	const results = await Promise.all([1, 2, 3].map(() => queue.submit("owner", click)));
	expect(new Set(results.map((result) => JSON.stringify(result))).size).toBe(1);
	expect(results[0]).toHaveProperty("jobId");
	expect(seen.posts).toBe(1);
	// A changed draft cannot reuse the claimed token.
	expect(
		await queue.submit("owner", { ...request(6), token: click.token, acceptTerms: true }),
	).toEqual({ error: "invalid" });
	expect(seen.posts).toBe(1);
});
