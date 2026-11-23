import { afterEach, beforeEach, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { sql } from "drizzle-orm";
import { createOwnerDirectory } from "../../../../../tests/fixtures/owner-directory";
import { seedanceOperation } from "../../../shared/media-catalog/registry";
import { parseVideo } from "../../../shared/video-studio/request";
import { videoDefaults } from "../../../shared/video-studio/seedance";
import { imageJobStore } from "../../db/image-job-store";
import { type Installation, openInstallation } from "../../db/installation";
import { providerStore } from "../../db/provider-store";
import { checkVideoInventory } from "../../providers/toapis/connection";
import { createJobTracking } from "../jobs/tracking";
import { loadStudioPricingFeeds } from "../pricing/studio-feeds";
import { createVideoAccess } from "../providers/video-access";
import { createVideoQueue } from "./video";

const raw = {
	draft: { ...videoDefaults, prompt: "  Rotate https://private.test/?secret  " },
	operationKey: seedanceOperation.key,
	count: 1,
	retryLimit: 0,
	acceptTerms: false,
};
const input = parseVideo(raw);
if (!input) throw new Error("Invalid fixture.");
const live = input;
let directory: string, db: Installation;
let now: number;
let jobs: ReturnType<typeof createJobTracking> | undefined;
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
function fixture() {
	const store = providerStore(db);
	let inventory: unknown = { success: true, object: "list", data: [{ id: "seedance-2-5" }] };
	const access = createVideoAccess(
		db,
		store,
		checkVideoInventory(async (url, init) => {
			expect(url).toBe("https://toapis.com/v1/models?type=video");
			expect(init.method).toBe("GET");
			return Response.json(inventory);
		}),
	);
	return {
		store,
		access,
		next: (value: unknown) => {
			inventory = value;
		},
	};
}
test("video checks preserve ciphertext, revision and image eligibility, with independent failed and missing results", async () => {
	const { store, access, next } = fixture();
	await store.save("toapis", "fixture", now, true, 0);
	const original = await db.use((c) =>
		c.get(sql`SELECT * FROM provider_credential WHERE provider='toapis'`),
	);
	for (const [response, state] of [
		[{ success: true, object: "list", data: [] }, "missing"],
		[{}, "unverified"],
		[{ success: true, object: "list", data: [{ id: "seedance-2-5" }] }, "eligible"],
	] as const) {
		next(response);
		expect((await access.check()).eligible).toBe(state === "eligible");
		expect((await access.current()).record?.state).toBe(state);
		expect(await store.credential("toapis", 1)).toEqual({ key: "fixture", revision: 1 });
	}
	expect((await access.check()).message).toContain("rate limited");
	expect(
		await db.use((c) => c.get(sql`SELECT * FROM provider_credential WHERE provider='toapis'`)),
	).toEqual(original);
});
test("one durable claim binds the eligible key, exact terms and transient draft before dispatch", async () => {
	const { store, access } = fixture();
	await store.save("toapis", "video-only", now, false, 0);
	let calls = 0;
	const queue = await createVideoQueue(
		db,
		access,
		async (id, key, send) => {
			calls++;
			expect(key).toBe("video-only");
			if (send.provider !== "toapis") throw new Error("Expected a ToAPIs target.");
			expect(send.body.prompt).toBe("Rotate https://private.test/?secret");
			expect(await imageJobStore(db).get(id)).toMatchObject({
				business_id: send.business,
				operation: seedanceOperation.key.operation,
			});
		},
		undefined,
		() => now,
	);
	const review = () => queue.review("owner", live);
	const click = async (token: string, acceptTerms = true) =>
		queue.submit("owner", { ...live, token, acceptTerms });
	async function blocked() {
		const r = await review();
		expect(r.blockers.length).toBeGreaterThan(0);
		expect(await click(r.token)).toEqual({ error: "stale" });
	}
	await blocked();
	await access.check();
	expect(await store.credential("toapis")).toBeNull();
	const first = await review();
	expect(first.quote).toMatchObject({
		reason: "token-usage-unknown",
		advertisedUnitRate: { usd: "10" },
	});
	expect(JSON.stringify(first.preview)).not.toContain("private.test");
	expect(await click(first.token, false)).toEqual({ error: "invalid" });
	now += 31 * 86400_000;
	expect(await click(first.token)).toEqual({ error: "stale" });
	now -= 31 * 86400_000;
	await store.save("toapis", "video-only", now, false, 1);
	expect(await click(first.token)).toEqual({ error: "stale" });
	await access.check();
	const r = await review();
	const clicks = await Promise.all([click(r.token), click(r.token)]);
	expect(clicks[0]).toEqual(clicks[1]);
	expect(calls).toBe(1);
	await store.remove("toapis");
	expect(await click(r.token)).toEqual(clicks[0]);
	expect(await queue.submit("other", { ...live, token: r.token, acceptTerms: true })).toEqual({
		error: "invalid",
	});
	expect(JSON.stringify(await imageJobStore(db).list())).not.toContain("private.test");
});
test("Review lists no verifier blocker", async () => {
	const { store, access } = fixture();
	await store.save("toapis", "video-only", now, false, 0);
	await access.check();
	const queue = await createVideoQueue(
		db,
		access,
		async () => {},
		undefined,
		() => now,
	);
	const review = await queue.review("owner", live);
	expect(review.blockers).toEqual([]);
	expect(JSON.stringify(review)).not.toMatch(/verifier/i);
	expect(review.disclosures.join(" ")).toContain("stays with the provider");
});
test("a rate withdrawn after Review requires a fresh Review before claim", async () => {
	const { store, access } = fixture();
	await store.save("toapis", "video-only", now, false, 0);
	await access.check();
	let priced = true,
		sends = 0;
	const queue = await createVideoQueue(
		db,
		access,
		async () => {
			sends++;
		},
		async (at) => (priced ? loadStudioPricingFeeds(at) : {}),
		() => now,
	);
	const review = await queue.review("owner", live);
	expect(review.quote).toMatchObject({ advertisedUnitRate: { usd: "10" } });
	priced = false;
	expect(await queue.submit("owner", { ...live, token: review.token, acceptTerms: true })).toEqual({
		error: "stale",
	});
	expect(await imageJobStore(db).list()).toHaveLength(0);
	expect(sends).toBe(0);
});
test("recovery reserves a single GET, retains Retry-After across reopen, attaches matching state once and never resends", async () => {
	const { store, access } = fixture();
	await store.save("toapis", "video-only", now, false, 0);
	await access.check();
	let posts = 0,
		reads = 0,
		business = "";
	let reply = () => new Response(null, { status: 503, headers: { "retry-after": "80" } });
	const tracker = () =>
		createJobTracking(db, providerStore(db), {
			now: () => now,
			random: () => 0,
			fetch: async (url, init) => {
				if (init.method === "POST") {
					posts++;
					business = JSON.parse(String(init.body)).client_business_id;
					throw new Error("lost acknowledgement");
				}
				reads++;
				expect(url.split("/").at(-1)).toMatch(new RegExp(`^(?:${business}|task_one)$`));
				return reply();
			},
		});
	jobs = tracker();
	const api = await createVideoQueue(db, access, jobs.dispatchVideo, undefined, () => now);
	const r = await api.review("owner", live);
	const result = await api.submit("owner", { ...live, token: r.token, acceptTerms: true });
	if (!("jobId" in result)) throw new Error("Missing claim");
	const id = result.jobId;
	expect(await jobs.needsCredential("toapis")).toBe(true);
	now += 5000;
	await Promise.all([jobs.lookup(id), jobs.lookup(id)]);
	expect(reads).toBe(1);
	const [uncertain] = await jobs.list();
	expect(uncertain).toMatchObject({ canLookup: true, nextReadAt: now + 80000 });
	expect(uncertain.message).toContain("temporarily unavailable");
	expect(uncertain.message).toContain("may still cost credits");
	expect(uncertain.message).toContain("Check provider history before authorizing another request.");
	jobs.close();
	await db.close();
	db = await openInstallation(directory);
	jobs = tracker();
	await jobs.resume();
	await jobs.lookup(id);
	expect(reads).toBe(1);
	const response = {
		id: "task_one",
		object: "generation.task",
		model: "seedance-2-5",
		client_business_id: business,
		status: "completed",
		progress: 100,
		expires_at: Math.floor(now / 1000) + 100000,
		billing: { status: "settled", cost_usd: "0.25", credits: "5" },
		result: { type: "video", data: [{ url: "https://cdn.example/result?private" }] },
	};
	now += 80000;
	reply = () => Response.json({ ...response, model: "routed-alias" });
	await jobs.lookup(id);
	expect((await imageJobStore(db).get(id))?.task_id).toBeNull();
	now += 5000;
	reply = () => Response.json(response);
	await jobs.lookup(id);
	expect(await imageJobStore(db).get(id)).toMatchObject({
		state: "completed",
		task_id: "task_one",
		video_progress: 100,
		video_poll_deadline: now + 600000,
	});
	// The completing lookup armed the save; its link went to the worker, so nothing reads now.
	const beforeSave = reads;
	expect((await jobs.list())[0]).toMatchObject({ library: "waiting" });
	const { next_read_at: cooldown } = (await imageJobStore(db).get(id)) ?? {};
	expect(await jobs.readForSave(id)).toEqual({ kind: "cooldown", until: cooldown ?? 0 });
	expect(reads).toBe(beforeSave);
	now += 5000;
	reply = () => Response.json({ ...response, model: "other" });
	expect(await jobs.readForSave(id)).toEqual({ kind: "paused", note: "unknown-status" });
	expect((await jobs.list())[0]).toMatchObject({ library: "paused" });
	now += 5000;
	reply = () =>
		Response.json(
			{ ...response, billing: { status: "pending" } },
			{ headers: { "retry-after": "65" } },
		);
	await jobs.refresh(id);
	expect((await jobs.list())[0].billing).toEqual({ status: "settled", usd: "0.25", credits: "5" });
	expect((await imageJobStore(db).get(id))?.next_read_at).toBe(now + 65000);
	expect(await jobs.readForSave(id)).toEqual({ kind: "cooldown", until: now + 65000 });
	now += 65000;
	reply = () => Response.json({ ...response, result: { type: "video", data: [{}] } });
	expect(await jobs.readForSave(id)).toEqual({ kind: "failed" });
	expect((await jobs.list())[0]).toMatchObject({ library: "waiting" });
	now += 5000;
	reply = () => new Response(null, { status: 503 });
	expect(await jobs.readForSave(id)).toEqual({ kind: "failed" });
	expect((await jobs.list())[0]).toMatchObject({ library: "waiting" });
	now += 10000;
	reply = () => Response.json({ ...response, result: { type: "video", data: [{}, {}] } });
	expect(await jobs.readForSave(id)).toEqual({ kind: "paused", note: "unsupported-video-result" });
	const [unsupported] = await jobs.list();
	expect(unsupported.library).toBe("paused");
	expect(unsupported.message).toContain("unsupported video result");
	now += 5000;
	reply = () => Response.json(response);
	await jobs.refresh(id);
	expect((await jobs.list())[0].library).toBe("waiting");
	expect(posts).toBe(1);
	expect(JSON.stringify(await imageJobStore(db).get(id))).not.toContain("?private");
});

test.each(["before-dispatch", "same-ack", "conflicting-ack"] as const)(
	"startup during %s preserves the original claim and lookup identity",
	async (point) => {
		const { store, access } = fixture();
		await store.save("toapis", "fixture", now, false, 0);
		await access.check();
		let posts = 0,
			reads = 0;
		const accepted = Promise.withResolvers<void>(),
			ack = Promise.withResolvers<Response>();
		let business = "",
			id = "";
		const server = createJobTracking(db, store, {
			now: () => now,
			fetch: async () => {
				posts++;
				accepted.resolve();
				return ack.promise;
			},
		});
		const api = await createVideoQueue(
			db,
			access,
			async (job, key, send) => {
				id = job;
				if (send.provider !== "toapis") throw new Error("Expected a ToAPIs target.");
				business = send.business;
				if (point === "before-dispatch") {
					accepted.resolve();
					return;
				}
				await server.dispatchVideo(job, key, send);
			},
			undefined,
			() => now,
		);
		const review = await api.review("owner", live);
		const click = { ...live, token: review.token, acceptTerms: true };
		const submitting = api.submit("owner", click);
		await accepted.promise;
		const second = await openInstallation(directory);
		const task = {
			id: "remote",
			model: "seedance-2-5",
			object: "generation.task",
			client_business_id: business,
			status: "in_progress",
			progress: 16,
			billing: { status: "pending" },
		};
		const started = Promise.withResolvers<void>(),
			release = Promise.withResolvers<void>();
		const read = async (url: string) => {
			reads++;
			expect(url.endsWith(business)).toBe(true);
			started.resolve();
			await release.promise;
			return point === "before-dispatch"
				? new Response(null, { status: 404 })
				: Response.json(task);
		};
		const other = createJobTracking(second, providerStore(second), { now: () => now, fetch: read });
		const competing = createJobTracking(db, store, { now: () => now, fetch: read });
		try {
			await other.resume();
			now += 5050;
			const lookup = other.lookup(id);
			await started.promise;
			await competing.lookup(id);
			expect(reads).toBe(1);
			release.resolve();
			await lookup;
			ack.resolve(Response.json({ ...task, id: point === "conflicting-ack" ? "other" : "remote" }));
			expect(await submitting).toEqual({ jobId: id });
			const stored = await imageJobStore(second).get(id);
			if (point === "before-dispatch") {
				expect(stored?.state).toBe("unknown");
				expect(stored?.task_id).toBeNull();
			} else {
				expect(stored).toMatchObject({
					task_id: "remote",
					state: "running",
					video_progress: 16,
					pause_reason: point === "conflicting-ack" ? "unknown-status" : null,
				});
			}
			expect(await api.submit("owner", click)).toEqual({ jobId: id });
			expect(posts).toBe(point === "before-dispatch" ? 0 : 1);
		} finally {
			release.resolve();
			ack.resolve(Response.json(task));
			server.close();
			competing.close();
			other.close();
			await second.close();
		}
	},
);

test("manual video reads keep an expired or failed task separate from its charge and stop at a changed revision", async () => {
	const { store, access } = fixture();
	await store.save("toapis", "fixture", now, false, 0);
	await access.check();
	const task = { object: "generation.task", model: "seedance-2-5", id: "pinned" };
	let status: Record<string, unknown> = { ...task, status: "queued" };
	let reads = 0,
		posts = 0;
	jobs = createJobTracking(db, store, {
		now: () => now,
		random: () => 0,
		fetch: async (_url, init) => {
			if (init.method === "POST") {
				posts++;
				return Response.json(task);
			}
			reads++;
			return Response.json(status);
		},
	});
	const queue = await createVideoQueue(db, access, jobs.dispatchVideo, undefined, () => now);
	async function queueOne() {
		const r = await queue.review("owner", live);
		const sent = await queue.submit("owner", { ...live, token: r.token, acceptTerms: true });
		if (!("jobId" in sent)) throw new Error("Missing claim");
		return sent.jobId;
	}
	const first = await queueOne();
	now += 600001;
	expect((await jobs.list())[0].tracking).toBe("manual");
	status = { ...task, status: "unrecognized", billing: { status: "settled", credits: "99" } };
	await jobs.refresh(first);
	expect((await jobs.list())[0]).toMatchObject({
		state: "waiting",
		billing: { status: "unknown" },
	});
	now += 5000;
	status = {
		...task,
		status: "failed",
		error: { code: 999, message: null },
		billing: { status: "refunded", credits: "0", cost_usd: "0" },
	};
	await jobs.refresh(first);
	expect((await jobs.list())[0]).toMatchObject({
		state: "failed",
		billing: { status: "refunded", credits: "0", usd: "0" },
	});
	const second = await queueOne();
	now += 5000;
	status = {
		...task,
		status: "completed",
		expires_at: Math.floor(now / 1000) - 1,
		billing: { status: "settled", credits: "5" },
		result: { type: "video", data: [{ url: "https://media.example/result" }] },
	};
	await jobs.refresh(second);
	expect((await jobs.list()).find((j) => j.id === second)).toMatchObject({
		state: "completed",
		library: "expired",
		retryable: false,
		billing: { status: "settled", credits: "5" },
	});
	now += 5000;
	expect(await jobs.readForSave(second)).toEqual({ kind: "expired" });
	await store.save("toapis", "changed", now, false, 1);
	now += 5000;
	const count = reads;
	expect(await jobs.readForSave(second)).toEqual({ kind: "expired" });
	expect(reads).toBe(count);
	expect(posts).toBe(2);
});

test.each(["before claim", "after claim", "during POST"])(
	"video shares the ToAPIs submit cooldown %s and replays accepted claims",
	async (when) => {
		const { store, access } = fixture();
		await store.save("toapis", "video-only", now, false, 0);
		await access.check();
		let posts = 0;
		const until = now + 20_000;
		const closeGate = () =>
			db.use((conn) =>
				conn.run(sql`UPDATE provider_gate SET submit_after=${until} WHERE provider='toapis'`),
			);
		jobs = createJobTracking(db, store, {
			now: () => now,
			fetch: async (_url, init) => {
				expect(init.method).toBe("POST");
				posts++;
				return Response.json(
					{ error: { code: "rate_limit_exceeded" } },
					{
						status: 429,
						headers: { "X-RateLimit-Category": "async_submit", "Retry-After": "20" },
					},
				);
			},
		});
		const tracker = jobs;
		const api = await createVideoQueue(
			db,
			access,
			async (...args) => {
				if (when === "after claim") await closeGate();
				await tracker.dispatchVideo(...args);
			},
			undefined,
			() => now,
		);
		const { token } = await api.review("owner", live);
		const click = () => api.submit("owner", { ...live, token, acceptTerms: true });
		if (when === "before claim") await closeGate();
		const first = await click();
		if (when === "before claim") {
			expect(first).toEqual({ error: "cooldown", until });
			expect(await jobs.list()).toHaveLength(0);
		} else {
			expect(await click()).toEqual(first);
			const [job] = await jobs.list();
			expect(job.state).toBe(when === "after claim" ? "unsent" : "unknown");
			if (when === "during POST") {
				expect(job.canLookup).toBe(true);
				const next = await api.review("owner", live);
				expect(
					await api.submit("owner", { ...live, token: next.token, acceptTerms: true }),
				).toEqual({ error: "cooldown", until });
			}
		}
		expect(posts).toBe(when === "during POST" ? 1 : 0);
	},
);

test("a video query throttle survives key replacement and defers a new image query", async () => {
	const { store, access } = fixture();
	await store.save("toapis", "first", now, true, 0);
	await access.check();
	let videoGets = 0,
		imageGets = 0;
	jobs = createJobTracking(db, store, {
		now: () => now,
		random: () => 0,
		fetch: async (url, init) => {
			if (init.method === "POST") throw new Error("Lost video acknowledgement");
			if (url.includes("image_task")) {
				imageGets++;
				return new Response(null, { status: 503 });
			}
			videoGets++;
			await store.save("toapis", "replacement", now, true, 1);
			return new Response(null, { status: 429, headers: { "Retry-After": "80" } });
		},
	});
	const api = await createVideoQueue(db, access, jobs.dispatchVideo, undefined, () => now);
	const { token } = await api.review("owner", live);
	const result = await api.submit("owner", { ...live, token, acceptTerms: true });
	if (!("jobId" in result)) throw new Error("Missing video job");
	now += 5000;
	await jobs.lookup(result.jobId);
	expect(videoGets).toBe(1);
	expect((await imageJobStore(db).get(result.jobId))?.task_id).toBeNull();
	await db.use((c) =>
		c.run(sql`INSERT INTO image_job
		(id,binding,provider,revision,quote,state,created_at,model,task_id,submission_recorded_at,poll_deadline)
		VALUES ('image','image-binding','toapis',2,'{}','waiting',${now - 5000},'doubao-seedream-5-5','image_task',${now - 5000},${now + 115000})`),
	);
	await jobs.refresh("image");
	expect(imageGets).toBe(0);
	expect((await imageJobStore(db).get("image"))?.next_read_at).toBe(now + 80000);
	now += 80000;
	await jobs.refresh("image");
	expect(imageGets).toBe(1);
});

test.each([false, true])(
	"recovery before video send keeps lookup available (cooldown %s)",
	async (cooldown) => {
		const { store, access } = fixture();
		await store.save("toapis", "video-only", now, false, 0);
		await access.check();
		let posts = 0;
		jobs = createJobTracking(db, store, {
			now: () => now,
			fetch: async () => {
				posts++;
				throw new Error("Unexpected transport start");
			},
		});
		// Reproduce recovery after dispatch begins and before its serialized send reservation.
		await db.use((c) =>
			c.run(
				sql.raw(`CREATE TRIGGER recover_before_video_send
		AFTER UPDATE OF dispatch_started_at ON image_job WHEN NEW.business_id IS NOT NULL
		BEGIN
			UPDATE image_job SET state='unknown' WHERE id=NEW.id;
			${cooldown ? "UPDATE provider_gate SET submit_after=253402300799000 WHERE provider='toapis';" : ""}
		END`),
			),
		);
		const queue = await createVideoQueue(db, access, jobs.dispatchVideo, undefined, () => now);
		const { token } = await queue.review("owner", live);
		const click = () => queue.submit("owner", { ...live, token, acceptTerms: true });
		const first = await click();
		expect(await click()).toEqual(first);
		expect(posts).toBe(0);
		const [job] = await jobs.list();
		expect(job).toMatchObject({ state: "unknown", canLookup: true });
	},
);
