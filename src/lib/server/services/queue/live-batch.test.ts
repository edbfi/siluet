import { afterEach, beforeEach, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { sql } from "drizzle-orm";
import { createOwnerDirectory } from "../../../../../tests/fixtures/owner-directory";
import { createSeedreamDraft } from "../../../shared/image-studio/seedream";
import type { PricingFeeds } from "../../../shared/pricing/feeds";
import type { ProviderId } from "../../../shared/providers/connections";
import { imageBatchStore } from "../../db/image-batch-store";
import { type Installation, openInstallation } from "../../db/installation";
import { providerStore } from "../../db/provider-store";
import type { CheckFetch } from "../../providers/connection-check";
import { batchHistory } from "../jobs/batch-history";
import { createJobTracking } from "../jobs/tracking";
import { loadBundledPricing } from "../pricing/local-feed";
import type { BatchAuthorization } from "./batch-dispatch";
import { parseQueueRequest } from "./request";
import { createSubmissionQueue } from "./submission";

const urls = [
	"https://art.example.org/image?signature=B%2f1",
	"https://art.example.org/image?signature=A%2f2",
];
const prompt = "stippled paper fixture marker";
let db: Installation;
let directory: string;
let jobs: ReturnType<typeof createJobTracking>;
let time: number;
let dispatched: Promise<void>[];
let read: CheckFetch;
let disclosure: string;
let feeds: PricingFeeds;
let beforeSleep: (() => Promise<void>) | undefined;
const timers = new Map<() => Promise<void>, number>();
async function advance(delay: number) {
	time += delay;
	for (const [run, due] of [...timers])
		if (due <= time) {
			timers.delete(run);
			await run();
		}
}
async function runtime(startBatch?: (auth: BatchAuthorization) => Promise<void>) {
	const store = providerStore(db);
	jobs = createJobTracking(db, store, {
		fetch: (...args) => read(...args),
		now: () => time,
		random: () => 0,
		scheduleRead: (run, delay) => {
			timers.set(run, time + delay);
			return () => {
				timers.delete(run);
			};
		},
		sleep: async (delay) => {
			await beforeSleep?.();
			await advance(delay);
		},
	});
	await jobs.resume();
	return createSubmissionQueue(
		db,
		store.credential,
		{
			dispatch: jobs.dispatch,
			dispatchBatch: (auth) => {
				const run = (startBatch ?? jobs.dispatchBatch)(auth);
				dispatched.push(run);
				return run;
			},
		},
		async () => feeds,
		() => time,
		() => [disclosure],
	);
}
type Queue = Awaited<ReturnType<typeof runtime>>;
function input(provider: ProviderId, count: number, retryLimit: number, edit = true) {
	const parsed = parseQueueRequest({
		draft: {
			...createSeedreamDraft(provider, edit ? "edit" : "generate"),
			prompt,
			references: edit ? urls.map((url) => ({ kind: "url", url })) : [],
		},
		count,
		retryLimit,
		acceptUnknown: true,
	});
	if (!parsed) throw new Error("Invalid fixture");
	return parsed;
}
async function review(
	queue: Queue,
	provider: ProviderId,
	count: number,
	retryLimit: number,
	edit = true,
) {
	const draft = input(provider, count, retryLimit, edit);
	const result = await queue.review("owner", draft);
	if (!("token" in result)) throw new Error("Review failed");
	return { ...draft, token: result.token };
}
function throttle(provider: ProviderId, delay?: string) {
	const headers = new Headers();
	if (delay) headers.set("Retry-After", delay);
	if (provider === "toapis") headers.set("X-RateLimit-Category", "async_submit");
	return Response.json(
		provider === "toapis"
			? { error: { code: "rate_limit_exceeded" } }
			: { code: 429, error: { type: "rate_limit_error" } },
		{ status: 429, headers },
	);
}
function balance(amount = 80) {
	return Response.json({ code: 200, data: { credits_amount: amount } });
}
beforeEach(async () => {
	directory = await createOwnerDirectory();
	db = await openInstallation(directory);
	time = 1_800_000_000_000;
	disclosure = "fixture disclosure v1";
	feeds = {};
	dispatched = [];
	beforeSleep = undefined;
	read = async () => {
		throw new Error("Unexpected fixture call");
	};
	for (const provider of ["poyo", "toapis"] as const)
		await providerStore(db).save(provider, "fixture-key", time, true, 0);
});
afterEach(async () => {
	jobs?.close();
	timers.clear();
	await db.close();
	await rm(directory, { recursive: true, force: true });
});
async function history() {
	const [header] = await jobs.batches();
	return batchHistory(header, await jobs.list());
}

test.each(["poyo", "toapis"] as const)(
	"%s caps an ordered batch at twenty POSTs, replays across restart and exhausts all five slots",
	async (provider) => {
		const posts: unknown[] = [];
		let balances = 0;
		read = async (url, init) => {
			if (url.endsWith("/balance")) {
				balances++;
				return balance(80 - balances);
			}
			expect(init.method).toBe("POST");
			posts.push(JSON.parse(String(init.body)));
			return throttle(provider);
		};
		const queue = await runtime();
		const click = await review(queue, provider, 5, 3);
		expect(posts).toBeEmpty();
		const [one, two] = await Promise.all([
			queue.submit("owner", click),
			queue.submit("owner", click),
		]);
		expect(one).toEqual(two);
		expect(dispatched).toHaveLength(1);
		await dispatched[0];
		expect(posts).toEqual(Array(20).fill(click.request.body));
		const batch = await history();
		expect(batch.counts.rejected).toBe(5);
		expect((await jobs.list()).map((job) => job.operation)).toEqual(
			Array(20).fill(click.entry.key.operation),
		);
		expect(batch.requests.map((r) => r.used)).toEqual([4, 4, 4, 4, 4]);
		expect(balances).toBe(provider === "poyo" ? 2 : 0);
		const attempts = await db.use((conn) =>
			conn.all<{ slot: number; attempt: number }>(
				sql`SELECT slot,attempt FROM image_job ORDER BY dispatch_started_at`,
			),
		);
		expect(attempts.slice(0, 5).map((row) => row.slot)).toEqual([1, 2, 3, 4, 5]);
		expect(attempts.slice(0, 5).every((row) => row.attempt === 1)).toBe(true);
		if (provider === "toapis")
			expect(batch.settlement).toEqual({ credits: "0", usd: "0", complete: false });
		await providerStore(db).remove(provider);
		jobs.close();
		await db.close();
		time += 200_000;
		db = await openInstallation(directory);
		const restarted = await runtime();
		expect(await restarted.submit("owner", click)).toEqual(one);
		expect(await restarted.submit("owner", { ...click, retryLimit: 2 })).toEqual({
			error: "invalid",
		});
		expect(posts).toHaveLength(20);
		expect(dispatched).toHaveLength(1);
	},
	15_000,
);

test("a headerless batch throttle closes a racing single's wallet before send and survives restart", async () => {
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	let balances = 0;
	let posts = 0;
	read = async (url) => {
		if (url.endsWith("/balance")) {
			if (++balances === 1) {
				entered.resolve();
				await release.promise;
			}
			return balance();
		}
		posts++;
		return throttle("poyo");
	};
	const queue = await runtime();
	const single = await review(queue, "poyo", 1, 0);
	const raced = queue.submit("owner", single);
	await entered.promise;
	// Let the batch send one throttle. Freeze backoff so its cooldown is still live.
	const sleeping = Promise.withResolvers<void>();
	const continueBatch = Promise.withResolvers<void>();
	beforeSleep = async () => {
		sleeping.resolve();
		await continueBatch.promise;
	};
	await queue.submit("owner", await review(queue, "poyo", 2, 0));
	await sleeping.promise;
	release.resolve();
	const result = await raced;
	const unused = await review(queue, "poyo", 1, 0);
	expect(await queue.submit("owner", unused)).toEqual({ error: "cooldown", until: time + 1000 });
	expect(await queue.submit("owner", single)).toEqual(result);
	expect(posts).toBe(1);
	expect(
		await db.use((conn) =>
			conn.get(
				sql`SELECT skipped,wallet_open,wallet_after,retry_at FROM image_job WHERE batch_id IS NULL`,
			),
		),
	).toEqual({
		skipped: "cooldown",
		wallet_open: 0,
		wallet_after: null,
		retry_at: time + 1000,
	});
	jobs.close();
	continueBatch.resolve();
	await dispatched[0];
	time -= 1000;
	await db.close();
	db = await openInstallation(directory);
	const restarted = await runtime();
	expect(await restarted.submit("owner", unused)).toMatchObject({ error: "cooldown" });
	expect(await restarted.submit("owner", single)).toEqual(result);
	expect(posts).toBe(1);
});

test.each(["deadline", "credential", "disclosure", "unknown", "rejection"] as const)(
	"dispatch records %s without risking an extra attempt",
	async (change) => {
		let posts = 0;
		let reads = 0;
		read = async (url) => {
			if (url.endsWith("/balance")) {
				reads++;
				if (change === "deadline") time += 120_000;
				return balance();
			}
			posts++;
			if (change === "credential") await providerStore(db).remove("poyo");
			if (change === "disclosure") disclosure = "fixture disclosure v2";
			if (change === "rejection")
				return Response.json({ code: 400, error: { type: "validation_error" } }, { status: 400 });
			if (change === "unknown") return new Response(null, { status: 502 });
			return Response.json({ code: 200, data: { task_id: "fixture-task" } });
		};
		const queue = await runtime();
		await queue.submit("owner", await review(queue, "poyo", 2, 3));
		await dispatched[0];
		const batch = await history();
		expect(posts).toBe(change === "deadline" ? 0 : change === "unknown" ? 2 : 1);
		expect(batch.reason).toBe(
			change === "deadline"
				? "expired"
				: change === "rejection"
					? "rejection"
					: change === "unknown"
						? "finished"
						: "terms",
		);
		if (change === "deadline") {
			expect(reads).toBe(1);
			expect(batch.counts.unsent).toBe(2);
			expect(
				await db.use((conn) => conn.get(sql`SELECT wallet_open,wallet_after FROM image_job`)),
			).toEqual({ wallet_open: 0, wallet_after: null });
		}
		if (change === "unknown") expect(batch.counts.uncertain).toBe(2);
	},
);

test.each([
	"automatic",
	"manual-first",
	"pending",
	"partial",
	"contradiction",
	"other-reason",
	"poyo-failed",
] as const)("only an automatic coherent transient refund arms another POST (%s)", async (mode) => {
	const provider = mode === "poyo-failed" ? "poyo" : "toapis";
	let posts = 0;
	let status = 0;
	read = async (url, init) => {
		if (url.endsWith("/balance")) return balance();
		if (init.method === "POST") {
			if (++posts > 1) return throttle(provider, "300");
			return Response.json(
				provider === "poyo" ? { code: 200, data: { task_id: "one" } } : { id: "one" },
			);
		}
		status++;
		if (provider === "poyo")
			return Response.json({
				code: 200,
				data: { task_id: "one", status: "failed", credits_amount: 0 },
			});
		const billing =
			mode === "pending" && status === 1
				? { status: "pending" }
				: mode === "contradiction"
					? { status: "refunded", credits: "0", cost_usd: "0.01" }
					: mode === "partial"
						? { status: "refunded", credits: "0" }
						: { status: "refunded", credits: "0.00", cost_usd: "0" };
		return Response.json({
			id: "one",
			status: "failed",
			error: { reason: mode === "other-reason" ? "invalid_image" : "service_busy" },
			billing,
		});
	};
	const queue = await runtime();
	let manuallyRead = false;
	if (mode === "manual-first")
		beforeSleep = async () => {
			if (manuallyRead) return;
			manuallyRead = true;
			time += 5000;
			const [job] = await jobs.list();
			await jobs.refresh(job.id);
			expect(posts).toBe(1);
			expect((await imageBatchStore(db).attempts(job.batchId ?? ""))[0].retry_state).not.toBe(
				"ready",
			);
		};
	await queue.submit("owner", await review(queue, provider, 1, 1, false));
	await dispatched[0];
	if (provider === "poyo") await advance(5000);
	expect(posts).toBe(["automatic", "manual-first", "pending"].includes(mode) ? 2 : 1);
	if (mode === "manual-first" || mode === "pending") expect(status).toBe(2);
	const batch = await history();
	expect(batch.counts.failed).toBe(1);
	expect(batch.requests[0].attempts[0].taskId).toBe("one");
	if (posts === 2) expect(batch.requests[0].attempts[1].throttled).toBe(true);
});

test("recovery distinguishes an unreserved slot, a reserved send, and an acknowledged task without sending again", async () => {
	const store = imageBatchStore(db);
	let posts = 0;
	let reads = 0;
	read = async (url, init) => {
		if (init.method === "POST") posts++;
		else reads++;
		return Response.json({
			id: url.split("/").at(-1),
			status: "completed",
			billing: { status: "settled", credits: "1.123456789", cost_usd: "0.001" },
		});
	};
	const queue = await runtime(async (auth) => {
		const check = await auth.checkTerms();
		const first = await store.reserve(auth.id, 1, () => time, check);
		if (!first.jobId) throw new Error("Missing reservation");
		// Crash fixture records the first response and leaves the next reservation
		// as it would appear on disk after loss of the second acknowledgement.
		await db.use((conn) =>
			conn.run(sql`UPDATE image_job SET state='waiting',submission_recorded_at=${time},task_id='first-accepted',next_read_at=${time},poll_deadline=${time + 120000}
			WHERE id=${first.jobId}`),
		);
		await store.reserve(auth.id, 2, () => time, check);
	});
	const click = await review(queue, "toapis", 3, 3);
	const original = await queue.submit("owner", click);
	await dispatched[0];
	jobs.close();
	await db.close();
	db = await openInstallation(directory);
	const restarted = await runtime();
	await advance(1);
	const recovered = await history();
	expect(recovered.counts).toMatchObject({ successful: 1, uncertain: 1, unsent: 1 });
	expect(recovered.requests.map((slot) => slot.used)).toEqual([1, 1, 0]);
	expect(recovered.settlement).toEqual({ complete: false, credits: "1.123456789", usd: "0.001" });
	expect(await restarted.submit("owner", click)).toEqual(original);
	expect(posts).toBe(0);
	expect(reads).toBe(1);
});

test.each([true, false])(
	"key replacement during an in-flight Poyo after-read discards the sample (batch=%s)",
	async (batch) => {
		let balances = 0;
		let posts = 0;
		read = async (url) => {
			if (url.endsWith("/balance")) {
				if (++balances === 2) await providerStore(db).save("poyo", "second-key", time, true, 1);
				return balance(50 - balances);
			}
			if (url.endsWith("/submit"))
				return Response.json({ code: 200, data: { task_id: `id-${++posts}` } });
			return Response.json({
				code: 200,
				data: { task_id: url.split("/").at(-1), status: "finished", credits_amount: 1 },
			});
		};
		const queue = await runtime();
		await queue.submit("owner", await review(queue, "poyo", batch ? 2 : 1, 0, false));
		await Promise.all(dispatched);
		await advance(2000);
		expect(balances).toBe(2);
		expect(posts).toBe(batch ? 2 : 1);
		expect(
			await db.use((conn) =>
				conn.get(
					sql`SELECT wallet_open,wallet_after,wallet_after_at FROM image_job WHERE wallet_before IS NOT NULL`,
				),
			),
		).toEqual({ wallet_open: 0, wallet_after: null, wallet_after_at: null });
	},
);

test.each(["before", "after"] as const)(
	"a missing %s balance preserves both Poyo batch results and withholds account movement",
	async (missing) => {
		let posts = 0;
		let balances = 0;
		read = async (url, init) => {
			if (url.endsWith("/balance")) {
				const sample = ++balances === 1 ? "before" : "after";
				return sample === missing ? new Response(null, { status: 503 }) : balance(81);
			}
			if (init.method === "POST")
				return Response.json({ code: 200, data: { task_id: `batch-${++posts}` } });
			return Response.json({
				code: 200,
				data: { task_id: url.split("/").at(-1), status: "finished", credits_amount: 2 },
			});
		};
		const queue = await runtime();
		await queue.submit("owner", await review(queue, "poyo", 2, 0));
		await dispatched[0];
		await advance(2000);
		const batch = await history();
		expect(posts).toBe(2);
		expect(balances).toBe(2);
		expect(batch.counts.successful).toBe(2);
		expect(batch.wallet).toEqual({ status: "unavailable", reason: "missing" });
	},
);

test("an isolated batch observes a single wallet interval and overlapping batches and singles suppress each other", async () => {
	let posts = 0;
	let balances = 0;
	read = async (url) => {
		if (url.endsWith("/balance")) return balance(100 - ++balances);
		if (url.endsWith("/submit"))
			return Response.json({ code: 200, data: { task_id: `p-${++posts}` } });
		return Response.json({
			code: 200,
			data: { task_id: url.split("/").at(-1), status: "failed", credits_amount: 0 },
		});
	};
	const queue = await runtime();
	await queue.submit("owner", await review(queue, "poyo", 2, 0));
	await Promise.all(dispatched);
	await advance(2000);
	expect((await jobs.list()).filter((job) => job.wallet).map((job) => job.wallet)).toMatchObject([
		{ status: "observed", delta: "-1" },
	]);
	expect(balances).toBe(2);
	for (const count of [2, 2, 1]) await queue.submit("owner", await review(queue, "poyo", count, 0));
	await Promise.all(dispatched);
	for (let step = 0; step < 4; step++) await advance(2000);
	expect(balances).toBe(8);
	expect(
		(await jobs.list()).filter(
			(job) => job.wallet?.status === "unavailable" && job.wallet.reason === "overlap",
		),
	).toHaveLength(3);
});

test.each(["poyo", "toapis"] as const)(
	"a sent single %s limiter stays uncertain and prevents subsequent claims",
	async (provider) => {
		let posts = 0;
		read = async (url) => {
			if (url.endsWith("/balance")) return balance();
			posts++;
			return throttle(provider, "130");
		};
		const queue = await runtime();
		const single = await review(queue, provider, 1, 0, false);
		const accepted = await queue.submit("owner", single);
		expect((await jobs.list())[0].state).toBe("unknown");
		expect(await queue.submit("owner", single)).toEqual(accepted);
		expect(await queue.submit("owner", await review(queue, provider, 1, 0, false))).toEqual({
			error: "cooldown",
			until: time + 130000,
		});
		await queue.submit("owner", await review(queue, provider, 5, 3, false));
		await dispatched[0];
		expect((await history()).counts.unsent).toBe(5);
		expect(posts).toBe(1);
	},
);

test("the accepted payload is frozen, tampered clicks fail and a price change stops later reservations", async () => {
	const queue = await runtime();
	const click = await review(queue, "poyo", 5, 1);
	for (const change of [
		{ retryLimit: 2 },
		{ count: 4 },
		{ acceptUnknown: false },
		{ ...input("toapis", 5, 1), token: click.token },
	]) {
		expect(await queue.submit("owner", { ...click, ...change })).toEqual({ error: "invalid" });
	}
	const bodies: unknown[] = [];
	const original = structuredClone(click.request.body);
	const hold = Promise.withResolvers<void>();
	read = async (url, init) => {
		if (url.endsWith("/balance")) {
			await hold.promise;
			return balance();
		}
		bodies.push(JSON.parse(String(init.body)));
		const poyo = await loadBundledPricing("poyo");
		if (poyo?.provider !== "poyo") throw new Error("Missing fixture rate");
		feeds = { poyo };
		return Response.json({ code: 200, data: { task_id: "frozen" } });
	};
	await queue.submit("owner", click);
	if (click.request.body.input)
		Object.assign(click.request.body.input, {
			prompt: "subsequent edit",
			image_urls: [...urls].reverse(),
		});
	hold.resolve();
	await dispatched[0];
	expect(bodies).toEqual([original]);
	expect((await history()).reason).toBe("terms");
	expect((await history()).counts.unsent).toBe(4);
});

test("status reads share a two-per-second budget and a provider cooldown across jobs and restart", async () => {
	let sends = 0;
	let reads = 0;
	read = async (url, init) => {
		if (init.method === "POST") return Response.json({ id: `query-${++sends}` });
		if (++reads === 2) return new Response(null, { status: 429, headers: { "Retry-After": "10" } });
		return Response.json({ id: url.split("/").at(-1), status: "pending" });
	};
	const queue = await runtime();
	await queue.submit("owner", await review(queue, "toapis", 5, 0));
	await dispatched[0];
	await advance(1000);
	await queue.submit("owner", await review(queue, "toapis", 1, 0));
	await advance(5000);
	expect(reads).toBe(2);
	jobs.close();
	await db.close();
	db = await openInstallation(directory);
	await runtime();
	await advance(9_999);
	expect(reads).toBe(2);
	await advance(1);
	expect(reads).toBe(4);
	expect(sends).toBe(6);
});

test("an uncertain batch still suppresses a fresh credential's wallet comparison", async () => {
	let posts = 0;
	let balances = 0;
	read = async (url, init) => {
		if (url.endsWith("/balance")) return balance(80 - ++balances);
		if (init.method === "POST") {
			posts++;
			if (posts === 1) throw new Error("fixture acknowledgement lost");
			return Response.json({ code: 200, data: { task_id: `new-${posts}` } });
		}
		return Response.json({
			code: 200,
			data: { task_id: url.split("/").at(-1), status: "finished" },
		});
	};
	const queue = await runtime();
	await queue.submit("owner", await review(queue, "poyo", 1, 2));
	await dispatched[0];
	await providerStore(db).save("poyo", "replacement", time, true, 1);
	await queue.submit("owner", await review(queue, "poyo", 2, 0));
	await dispatched[1];
	await advance(2000);
	const rows = await jobs.list();
	expect(rows.some((job) => job.wallet?.status === "observed")).toBe(false);
	expect(
		rows.some((job) => job.wallet?.status === "unavailable" && job.wallet.reason === "overlap"),
	).toBe(true);
	expect(posts).toBe(3);
});

test("manual Refresh without a failure reason preserves automatic refund proof and its due time", async () => {
	let posts = 0;
	let reads = 0;
	let checked = false;
	read = async (_url, init) => {
		if (init.method === "POST")
			return ++posts === 1
				? Response.json({ id: "busy" })
				: Response.json({ error: { code: "invalid_image" } }, { status: 400 });
		return Response.json(
			{
				id: "busy",
				status: "failed",
				error: ++reads === 1 ? { reason: "request_rate_limited" } : {},
				billing: { status: "refunded", credits: "0", cost_usd: "0.0" },
			},
			{ headers: { "Retry-After": "11" } },
		);
	};
	const queue = await runtime();
	beforeSleep = async () => {
		if (checked) return;
		const [batch] = await jobs.batches();
		const [job] = await imageBatchStore(db).attempts(batch.id);
		if (job.retry_state !== "ready") return;
		checked = true;
		time += 5000;
		await jobs.refresh(job.id);
		const [after] = await imageBatchStore(db).attempts(batch.id);
		expect(reads).toBe(2);
		expect(after.retry_state).toBe("ready");
		expect(after.retry_at).toBe(job.retry_at);
		expect(posts).toBe(1);
	};
	await queue.submit("owner", await review(queue, "toapis", 1, 1));
	await dispatched[0];
	expect(checked).toBe(true);
	expect(posts).toBe(2);
});

test.each(["missing reason", "unrecognized status", "failure before automatic progress"])(
	"a manual %s leaves the automatic observer its own read after cooldown",
	async (manual) => {
		let posts = 0;
		let billingAfterProgress: string | undefined;
		const reads: number[] = [];
		read = async (_url, init) => {
			if (init.method === "POST")
				return ++posts === 1
					? Response.json({ id: "busy" })
					: Response.json({ error: { code: "invalid_image" } }, { status: 400 });
			reads.push(time);
			const first = reads.length === 1;
			if (manual === "failure before automatic progress" && reads.length === 3)
				billingAfterProgress = (await history()).requests[0].attempts[0].billing?.status;
			if (manual === "failure before automatic progress" && reads.length === 2)
				return Response.json({
					id: "busy",
					status: "in_progress",
					billing: { status: "refunded", credits: "0", cost_usd: "0" },
				});
			return Response.json({
				id: "busy",
				status: first && manual === "unrecognized status" ? "undocumented" : "failed",
				error: first ? undefined : { reason: "service_busy" },
				billing:
					first && manual === "failure before automatic progress"
						? undefined
						: { status: "refunded", credits: "0", cost_usd: "0" },
			});
		};
		const queue = await runtime();
		beforeSleep = async () => {
			beforeSleep = undefined;
			time += 5000;
			const [job] = await jobs.list();
			await jobs.refresh(job.id);
			const [row] = await imageBatchStore(db).attempts(job.batchId ?? "");
			expect(row.retry_state).toBe("watch");
			expect(row.retry_at).toBeNull();
			expect(posts).toBe(1);
		};
		await queue.submit("owner", await review(queue, "toapis", 1, 1));
		await dispatched[0];
		expect(reads).toHaveLength(manual === "failure before automatic progress" ? 3 : 2);
		expect(reads[1] - reads[0]).toBeGreaterThanOrEqual(5000);
		expect(posts).toBe(2);
		if (manual === "failure before automatic progress")
			expect(billingAfterProgress).toBe("unknown");
	},
);

test.each(["settled first", "conflict first", "settled during backoff"])(
	"contradictory settlement blocks a new POST (%s)",
	async (sequence) => {
		let posts = 0;
		let reads = 0;
		let refreshed = false;
		read = async (_url, init) => {
			if (init.method === "POST")
				return ++posts === 1
					? Response.json({ id: "busy" })
					: Response.json({ error: { code: "invalid_image" } }, { status: 400 });
			reads++;
			const refund = reads === (sequence === "settled during backoff" ? 1 : 2);
			return Response.json(
				{
					id: "busy",
					status: "failed",
					error: { reason: "service_busy" },
					billing: refund
						? { status: "refunded", credits: "0", cost_usd: "0" }
						: {
								status: sequence === "conflict first" ? "refunded" : "settled",
								credits: "5.6",
								cost_usd: "0.028",
							},
				},
				{ headers: { "Retry-After": "11" } },
			);
		};
		const queue = await runtime();
		beforeSleep = async () => {
			if (refreshed) return;
			const [job] = await jobs.list();
			const [attempt] = await imageBatchStore(db).attempts(job.batchId ?? "");
			if (sequence === "settled during backoff" && attempt.retry_state !== "ready") return;
			time += 5000;
			refreshed = true;
			await jobs.refresh(job.id);
		};
		await queue.submit("owner", await review(queue, "toapis", 1, 1));
		await dispatched[0];
		expect(refreshed).toBe(true);
		expect(reads).toBe(2);
		expect(posts).toBe(1);
		const batch = await history();
		expect(batch.settlement?.complete).toBe(false);
		expect(batch.requests[0].attempts[0].billing?.status).toBe("conflicting");
	},
);

test.each([
	{ completedFirst: true, charged: false, refunded: true },
	{ completedFirst: false, charged: false, refunded: true },
	{ completedFirst: true, charged: true, refunded: false },
	{ completedFirst: false, charged: true, refunded: false },
	{ completedFirst: true, charged: true, refunded: true },
	{ completedFirst: false, charged: true, refunded: true },
])(
	"opposite terminal observations leave settlement unverified %j",
	async ({ completedFirst, charged, refunded }) => {
		let posts = 0;
		let reads = 0;
		let refreshed = false;
		read = async (_url, init) => {
			if (init.method === "POST") return Response.json({ id: `task-${++posts}` });
			const complete = ++reads === (completedFirst ? 1 : 2);
			return Response.json(
				complete
					? {
							id: "task-1",
							status: "completed",
							billing: charged ? { status: "settled", credits: "5", cost_usd: "0.03" } : undefined,
							result: { type: "image", data: [{ url: "https://media.example/result.png" }] },
						}
					: {
							id: "task-1",
							status: "failed",
							error: { reason: "service_busy" },
							billing: refunded ? { status: "refunded", credits: "0", cost_usd: "0" } : undefined,
						},
				{ headers: { "Retry-After": "11" } },
			);
		};
		const queue = await runtime();
		beforeSleep = async () => {
			if (refreshed) return;
			const [job] = await jobs.list();
			if (!completedFirst && reads === 0) return;
			refreshed = true;
			time += 5000;
			await jobs.refresh(job.id);
		};
		await queue.submit("owner", await review(queue, "toapis", 1, 1));
		await dispatched[0];
		expect(refreshed).toBe(true);
		expect(reads).toBeGreaterThanOrEqual(2);
		expect(posts).toBe(1);
		expect((await history()).settlement).toEqual({ complete: false, credits: "0", usd: "0" });
	},
);

test("a settlement conflict between reservation and send skips one retry and permits its sibling", async () => {
	// Commit the late observation at the reservation boundary, before the send gate rechecks it.
	await db.use((conn) =>
		conn.run(sql`CREATE TRIGGER late_charge AFTER INSERT ON image_job
		WHEN NEW.slot=1 AND NEW.attempt=2 BEGIN
		UPDATE image_job SET billing='{"status":"conflicting"}'
		WHERE batch_id=NEW.batch_id AND slot=1 AND attempt=1;
		END`),
	);
	let posts = 0;
	read = async (url, init) => {
		if (init.method === "POST") return Response.json({ id: `task-${++posts}` });
		return Response.json({
			id: url.split("/").at(-1),
			status: "failed",
			error: { reason: "service_busy" },
			billing: { status: "refunded", credits: "0", cost_usd: "0" },
		});
	};
	const queue = await runtime();
	await queue.submit("owner", await review(queue, "toapis", 2, 1));
	await dispatched[0];
	const batch = await history();
	expect(posts).toBe(3);
	expect(batch.requests.map((r) => r.used)).toEqual([1, 2]);
	expect(batch.requests[0].attempts[1].state).toBe("unsent");
	expect(batch.requests[0].attempts[1].message).toContain("retry");
	expect(batch.settlement?.complete).toBe(false);
});

test.each([
	{ boundary: "reservation", observation: "completed" },
	{ boundary: "send", observation: "completed" },
	{ boundary: "reservation", observation: "charged" },
	{ boundary: "send", observation: "charged" },
])(
	"attempt one rules out attempt three only for its own slot %j",
	async ({ boundary, observation }) => {
		const atBoundary = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const gateOccupied = Promise.withResolvers<void>();
		const attempts = imageBatchStore(db).attempts;
		let batchPosts = 0;
		let competing: Promise<unknown> | undefined;
		let late = false;
		read = async (url, init) => {
			if (init.method === "POST") {
				if (!JSON.parse(String(init.body)).image_urls) {
					gateOccupied.resolve();
					await release.promise;
					return Response.json({ id: "single" });
				}
				return Response.json({ id: `task-${++batchPosts}` });
			}
			const id = url.split("/").at(-1);
			const corrected = late && id === "task-1";
			if (corrected && observation === "completed")
				return Response.json({
					id,
					status: "completed",
					result: { data: [{ url: "https://media.example/image" }] },
				});
			return Response.json({
				id,
				status: "failed",
				error: { reason: "service_busy" },
				billing: corrected
					? { status: "settled", credits: "5", cost_usd: "0.03" }
					: { status: "refunded", credits: "0", cost_usd: "0" },
			});
		};
		const queue: Queue = await runtime((auth) =>
			jobs.dispatchBatch({
				...auth,
				checkTerms: async () => {
					const check = await auth.checkTerms();
					const rows = await attempts(auth.id);
					const second = rows.find((row) => row.slot === 1 && row.attempt === 2);
					if (late || second?.retry_state !== "ready") return check;
					if (boundary === "reservation") {
						atBoundary.resolve();
						await release.promise;
						return check;
					}
					// Keep the provider's serialized POST occupied while attempt three reserves.
					competing = queue.submit("owner", await review(queue, "toapis", 1, 0, false));
					await gateOccupied.promise;
					return () => {
						atBoundary.resolve();
						return check();
					};
				},
			}),
		);
		const click = await review(queue, "toapis", 2, 2);
		await queue.submit("owner", click);
		await atBoundary.promise;
		try {
			const [batch] = await jobs.batches();
			const slot = (await attempts(batch.id)).filter((row) => row.slot === 1);
			expect(slot.map((row) => row.attempt)).toEqual(boundary === "send" ? [1, 2, 3] : [1, 2]);
			expect(batchPosts).toBe(4);
			late = true;
			time += 1000;
			await jobs.refresh(slot[0].id);
		} finally {
			release.resolve();
		}
		await Promise.all([dispatched[0], competing]);
		const batch = await history();
		expect(batchPosts).toBe(5);
		expect(batch.requests.map((r) => r.used)).toEqual([2, 3]);
		expect(batch.requests[0].attempts.map((a) => a.skipped)).toEqual(
			boundary === "send" ? [null, null, "retry-evidence"] : [null, null],
		);
		expect(batch.requests[0].outcome).toBe(observation === "completed" ? "successful" : "failed");
		expect(batch.requests[0].attempts[0].canSave).toBe(observation === "completed");
		expect(batch.requests[0].attempts[0].billing?.status).toBe("conflicting");
		expect(batch.counts.successful).toBe(observation === "completed" ? 1 : 0);
		expect(batch.settlement?.complete).toBe(false);
	},
);

test.each([1, 2])(
	"a failed ToAPIs task carrying %i image results cannot authorize another POST",
	async (count) => {
		let posts = 0;
		let reads = 0;
		read = async (_url, init) => {
			if (init.method === "POST") return Response.json({ id: `task-${++posts}` });
			reads++;
			return Response.json({
				id: "task-1",
				status: "failed",
				error: { reason: "service_busy" },
				billing: { status: "refunded", credits: "0", cost_usd: "0" },
				result: {
					type: "image",
					data: Array.from({ length: count }, (_, i) => ({
						url: `https://art.example.org/finished-${i}.png`,
					})),
				},
			});
		};
		const queue = await runtime();
		await queue.submit("owner", await review(queue, "toapis", 1, 3));
		await dispatched[0];
		expect(posts).toBe(1);
		expect(reads).toBe(1);
		const batch = await history();
		expect(batch.counts.paused).toBe(1);
		expect(batch.requests[0].attempts[0].taskId).toBe("task-1");
		expect(batch.settlement?.complete).toBe(false);
	},
);

test("a closed query bucket's advertised reset outlives the task clock", async () => {
	let reads = 0;
	let posts = 0;
	const reset = (time + 20_000) / 1000;
	read = async (url, init) => {
		if (init.method === "POST") return Response.json({ id: `db-${++posts}` });
		reads++;
		return Response.json(
			{ id: url.split("/").at(-1), status: "pending" },
			{
				headers: {
					"X-RateLimit-Category": "async_query",
					"X-RateLimit-Remaining": "0",
					"X-RateLimit-Reset": String(reset),
				},
			},
		);
	};
	const queue = await runtime();
	await queue.submit("owner", await review(queue, "toapis", 3, 0));
	await dispatched[0];
	await advance(5000);
	expect(reads).toBe(1);
	await advance(14000);
	expect(reads).toBe(1);
});
