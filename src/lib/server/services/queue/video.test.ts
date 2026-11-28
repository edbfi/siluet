import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { sql } from "drizzle-orm";
import toapisBundle from "../../../../../pricing/v2/toapis.json";
import { createOwnerDirectory } from "../../../../../tests/fixtures/owner-directory";
import {
	type SeedanceOperation,
	seedanceEditOperation,
	seedanceKeyframeOperations,
	seedanceOperation,
} from "../../../shared/media-catalog/registry";
import { skippedText, staleText } from "../../../shared/providers/inventory";
import { keyframeDisclosures } from "../../../shared/video-studio/keyframes";
import {
	parseVideo,
	type VideoRequest,
	videoReviewDisclosures,
} from "../../../shared/video-studio/request";
import { type SaveLimit, saveLimitBlocker } from "../../../shared/video-studio/save-profile";
import { videoDefaults } from "../../../shared/video-studio/seedance";
import { editDisclosures } from "../../../shared/video-studio/source-edit";
import { imageJobStore } from "../../db/image-job-store";
import { type Installation, openInstallation } from "../../db/installation";
import { providerStore } from "../../db/provider-store";
import { createJobTracking } from "../jobs/tracking";
import { loadStudioPricingFeeds } from "../pricing/studio-feeds";
import { createInventory } from "../providers/inventory";
import { createVideoAccess } from "../providers/video-access";
import { createVideoQueue, type VideoTarget } from "./video";

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
	// One day after the bundled ToAPIs observation, so its rates are current.
	now = Date.parse(toapisBundle.observedAt) + 86_400_000;
});
afterEach(async () => {
	jobs?.close();
	await db.close();
	await rm(directory, { recursive: true, force: true });
});
/**
 * A stale video claim's answer: the refusal and a fresh Review to show instead. A plain subset,
 * because Bun's toMatchObject rewrites the received value where an asymmetric matcher matched.
 */
const staleWithReview = { error: "stale", review: {} };
function fixture() {
	const store = providerStore(db);
	let inventory: unknown = { success: true, object: "list", data: [{ id: "seedance-2-5" }] };
	let elapsed = 0;
	const reads: string[] = [];
	const service = createInventory(db, store, {
		read: async (url, init) => {
			reads.push(url);
			expect(url).toBe("https://toapis.com/v1/models?type=video");
			expect(init.method).toBe("GET");
			if (inventory instanceof Error) throw inventory;
			return inventory instanceof Response ? inventory : Response.json(inventory);
		},
		now: () => now,
		// Each check is a minute apart, so a fixture's checks never meet the limit.
		elapsed: () => (elapsed += 60_001),
	});
	return {
		store,
		access: createVideoAccess(db, store),
		inventory: service,
		reads,
		check: () => service.check("video"),
		next: (value: unknown) => {
			inventory = value;
		},
	};
}
describe("ToAPIs inventory access", () => {
	const listing = (...ids: string[]) => ({
		success: true,
		object: "list",
		data: ids.map((id) => ({ id })),
	});
	async function inventoryQueue(saveFirst = true) {
		const f = fixture();
		if (saveFirst) await f.store.save("toapis", "video-only", now, false, 0);
		const posts: VideoTarget[] = [];
		const queue = await createVideoQueue(
			db,
			f.access,
			async (_id, _key, send) => {
				posts.push(send);
			},
			undefined,
			() => now,
			f.inventory,
		);
		const queueReview = async (request: VideoRequest = live) => {
			const review = await queue.review("owner", request);
			return {
				review,
				click: () => queue.submit("owner", { ...request, token: review.token, acceptTerms: true }),
			};
		};
		return { ...f, posts, queue, queueReview };
	}

	test("a fresh listing queues, and Review shows its access line", async () => {
		const { check, queueReview, posts } = await inventoryQueue();
		await check();
		const { review, click } = await queueReview();
		expect(review.blockers).toEqual([]);
		expect(review.access).toEqual({
			state: "listed",
			text: expect.stringMatching(/^ToAPIs listed seedance-2-5 for this key at .+ UTC\.$/),
		});
		expect(await click()).toEqual({ jobId: expect.any(String) });
		expect(posts).toHaveLength(1);
	});

	test.each([
		["absent", listing("seedance-2-0"), "ToAPIs did not list seedance-2-5 for this key at"],
		["failed", new Response(null, { status: 503 }), "The ToAPIs model check failed at"],
	] as const)("an %s snapshot blocks Queue with zero POSTs", async (_, reply, text) => {
		const { check, next, queueReview, posts } = await inventoryQueue();
		next(reply);
		await check();
		const { review, click } = await queueReview();
		expect(review.access?.text).toStartWith(text);
		expect(review.blockers).toEqual([String(review.access?.text)]);
		expect(await click()).toMatchObject(staleWithReview);
		expect(posts).toHaveLength(0);
	});

	test("a stale snapshot whose automatic check cannot reach ToAPIs is skipped with zero POSTs", async () => {
		const { check, next, queueReview, posts, reads } = await inventoryQueue();
		await check();
		now += 86_400_000;
		next(Object.assign(new TypeError("fixture connect failure"), { code: "ECONNREFUSED" }));
		const { review, click } = await queueReview();
		expect(reads).toHaveLength(2);
		expect(review.access).toEqual({ state: "stale", text: skippedText });
		expect(review.blockers).toEqual([skippedText]);
		const refused = await click();
		expect(refused).toMatchObject(staleWithReview);
		// The stale answer's fresh Review only reads: no second automatic check.
		expect(reads).toHaveLength(2);
		if ("review" in refused) expect(refused.review.access?.text).toBe(staleText);
		expect(posts).toHaveLength(0);
	});

	test("another revision's snapshot leaves the model unknown with zero POSTs", async () => {
		const { check, store, queueReview, posts } = await inventoryQueue();
		await check();
		await store.save("toapis", "video-replaced", now, false, 1);
		const { review, click } = await queueReview();
		expect(review.access).toEqual({ state: "unchecked", text: "Check ToAPIs model access." });
		expect(await click()).toMatchObject(staleWithReview);
		expect(posts).toHaveLength(0);
	});

	test("a Check again between Review and Queue makes the Review stale", async () => {
		const { check, queueReview, posts } = await inventoryQueue();
		await check();
		const { click } = await queueReview();
		now += 1000;
		await check();
		const refused = await click();
		expect(refused).toMatchObject(staleWithReview);
		if ("review" in refused) expect(refused.review.blockers).toEqual([]);
		expect(posts).toHaveLength(0);
	});

	test("24 hours after the check the claim is stale, and its fresh Review sends no GET", async () => {
		const { check, queueReview, posts, reads } = await inventoryQueue();
		await check();
		const { click } = await queueReview();
		now += 86_400_000;
		const refused = await click();
		expect(refused).toMatchObject(staleWithReview);
		if ("review" in refused)
			expect(refused.review.access).toEqual({ state: "stale", text: staleText });
		expect(reads).toHaveLength(1);
		expect(posts).toHaveLength(0);
		// Opening Review again runs the one automatic check, and Queue then succeeds.
		const reopened = await queueReview();
		expect(reads).toHaveLength(2);
		expect(reopened.review.access?.state).toBe("listed");
		expect(await reopened.click()).toEqual({ jobId: expect.any(String) });
		expect(posts).toHaveLength(1);
	});

	test("the Seedance exception queues before any snapshot and ends at a failed check", async () => {
		const { check, next, queueReview, posts } = await inventoryQueue();
		await db.use((c) =>
			c.run(sql`INSERT INTO model_access VALUES ('toapis','seedance-2-5',1,'eligible',${now})`),
		);
		const first = await queueReview();
		expect(first.review.access).toEqual({
			state: "exception",
			text: "Seedance 2.5 was listed for this key.",
		});
		expect(await first.click()).toEqual({ jobId: expect.any(String) });
		next(new Response(null, { status: 500 }));
		await check();
		const second = await queueReview();
		expect(second.review.access?.state).toBe("failed");
		expect(await second.click()).toMatchObject(staleWithReview);
		expect(posts).toHaveLength(1);
	});

	test("a derived video key gets no exception", async () => {
		const { queueReview, posts } = await inventoryQueue();
		await db.use((c) =>
			c.run(sql`INSERT INTO model_access VALUES ('toapis','seedance-2-5',1,'eligible',${now})`),
		);
		const derived = {
			...live,
			operation: {
				...live.operation,
				key: { ...live.operation.key, operation: "fixture-derived-video" },
			},
		} as unknown as VideoRequest;
		const { review, click } = await queueReview(derived);
		expect(review.access?.state).toBe("unchecked");
		expect(await click()).toMatchObject(staleWithReview);
		expect(posts).toHaveLength(0);
	});

	test("with no readable key Review keeps today's text and sends no GET", async () => {
		const { queueReview, reads } = await inventoryQueue(false);
		const { review } = await queueReview();
		expect(review.access).toEqual({
			state: "disconnected",
			text: "Connect a readable ToAPIs model key in Settings.",
		});
		expect(reads).toHaveLength(0);
	});
});

test("one durable claim binds the eligible key, exact terms and transient draft before dispatch", async () => {
	const { store, access, check } = fixture();
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
		expect(await click(r.token)).toMatchObject(staleWithReview);
	}
	await blocked();
	await check();
	expect(await store.credential("toapis")).toBeNull();
	const first = await review();
	expect(first.quote).toMatchObject({
		reason: "token-usage-unknown",
		advertisedUnitRate: { usd: "10" },
	});
	expect(JSON.stringify(first.preview)).not.toContain("private.test");
	expect(await click(first.token, false)).toEqual({ error: "invalid" });
	now += 31 * 86400_000;
	expect(await click(first.token)).toMatchObject(staleWithReview);
	now -= 31 * 86400_000;
	await store.save("toapis", "video-only", now, false, 1);
	expect(await click(first.token)).toMatchObject(staleWithReview);
	await check();
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
	const { store, access, check } = fixture();
	await store.save("toapis", "video-only", now, false, 0);
	await check();
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
/** The live Seedance input under a test-only copy of its operation with another Save limit. */
function withSave(save: SaveLimit | null, disclosuresFrom: SaveLimit | null = save) {
	const operation = { ...seedanceOperation, save };
	const disclosures = videoReviewDisclosures({ ...seedanceOperation, save: disclosuresFrom });
	// `live` parsed as Seedance text-to-video, so its body matches the copied operation.
	return { ...live, operation, disclosures } as VideoRequest;
}
test("a 20-second mode reviews its limit, binds it into the terms digest and stores it", async () => {
	const { store, access, check } = fixture();
	await store.save("toapis", "video-only", now, false, 0);
	await check();
	const sent: VideoTarget[] = [];
	const queue = await createVideoQueue(
		db,
		access,
		async (_id, _key, send) => {
			sent.push(send);
		},
		undefined,
		() => now,
	);
	const twenty = withSave({ seconds: 20, basis: "provider" });
	const review = await queue.review("owner", twenty);
	expect(review.blockers).toEqual([]);
	expect(review.disclosures.at(-1)).toContain(
		"up to 20 seconds, the provider's documented maximum",
	);
	expect(review.disclosures.join(" ")).not.toContain("30 seconds");
	// The same disclosures under a 21-second limit no longer match the reviewed terms.
	const changed = withSave({ seconds: 21, basis: "provider" }, { seconds: 20, basis: "provider" });
	const click = { token: review.token, acceptTerms: true };
	expect(await queue.submit("owner", { ...changed, ...click })).toMatchObject(staleWithReview);
	expect(sent).toHaveLength(0);
	const claimed = await queue.submit("owner", { ...twenty, ...click });
	if (!("jobId" in claimed)) throw new Error("Missing claim");
	expect(sent).toHaveLength(1);
	// Save reads the limit the job was reviewed and claimed with.
	expect(await imageJobStore(db).get(claimed.jobId)).toMatchObject({ save_seconds: 20 });
});
test("a mode without a Save limit is Review-only and Queue makes zero POSTs", async () => {
	const { store, access, check } = fixture();
	await store.save("toapis", "video-only", now, false, 0);
	await check();
	let sends = 0;
	const queue = await createVideoQueue(
		db,
		access,
		async () => {
			sends++;
		},
		undefined,
		() => now,
	);
	for (const save of [null, { seconds: 61, basis: "provider" } as const]) {
		const unbounded = withSave(save);
		const review = await queue.review("owner", unbounded);
		expect(review.blockers).toEqual([saveLimitBlocker]);
		expect(review.disclosures.join(" ")).not.toContain("Gallery saves");
		expect(
			await queue.submit("owner", { ...unbounded, token: review.token, acceptTerms: true }),
		).toMatchObject(staleWithReview);
	}
	expect(sends).toBe(0);
	expect(await imageJobStore(db).list()).toHaveLength(0);
});
test("a rate withdrawn after Review requires a fresh Review before claim", async () => {
	const { store, access, check } = fixture();
	await store.save("toapis", "video-only", now, false, 0);
	await check();
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
	expect(
		await queue.submit("owner", { ...live, token: review.token, acceptTerms: true }),
	).toMatchObject(staleWithReview);
	expect(await imageJobStore(db).list()).toHaveLength(0);
	expect(sends).toBe(0);
});
test("recovery reserves a single GET, retains Retry-After across reopen, attaches matching state once and never resends", async () => {
	const { store, access, check } = fixture();
	await store.save("toapis", "video-only", now, false, 0);
	await check();
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
	expect(unsupported).toMatchObject({ library: "unsupported", retryable: false });
	expect(unsupported.message).toContain("unsupported video result");
	// The held result stays held even when a later read finds one clip.
	now += 5000;
	reply = () => Response.json(response);
	await jobs.refresh(id);
	expect((await jobs.list())[0]).toMatchObject({ library: "unsupported", retryable: false });
	expect(posts).toBe(1);
	expect(JSON.stringify(await imageJobStore(db).get(id))).not.toContain("?private");
});

test.each(["before-dispatch", "same-ack", "conflicting-ack"] as const)(
	"startup during %s preserves the original claim and lookup identity",
	async (point) => {
		const { store, access, check } = fixture();
		await store.save("toapis", "fixture", now, false, 0);
		await check();
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
	const { store, access, check } = fixture();
	await store.save("toapis", "fixture", now, false, 0);
	await check();
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
		const { store, access, check } = fixture();
		await store.save("toapis", "video-only", now, false, 0);
		await check();
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
	const { store, access, check } = fixture();
	await store.save("toapis", "first", now, true, 0);
	await check();
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
		const { store, access, check } = fixture();
		await store.save("toapis", "video-only", now, false, 0);
		await check();
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

describe("Seedance keyframes", () => {
	const start = "https://frames.example.com/start.png?X-Amz-Signature=one";
	const end = "https://frames.example.com/end.png?X-Amz-Signature=two";
	const [animate, interpolate] = seedanceKeyframeOperations;
	const keyframeDraft = {
		prompt: "Drift",
		duration: 5,
		resolution: "720p",
		generate_audio: true,
		frames: [
			{ role: "first_frame", url: start },
			{ role: "last_frame", url: end },
		],
	};
	const parse = (operation: SeedanceOperation, frames = keyframeDraft.frames) => {
		const parsed = parseVideo({
			...raw,
			operationKey: operation.key,
			draft: { ...keyframeDraft, frames: frames.slice(0, operation.roles.length) },
		});
		if (!parsed) throw new Error("Invalid keyframe fixture.");
		return parsed;
	};
	const durable = async () =>
		JSON.stringify(await db.use((c) => c.all(sql`SELECT * FROM image_job`)));

	test.each([
		["animate", animate],
		["interpolate", interpolate],
	])("%s quotes the advertised token rate and labels frames without URLs", async (_, operation) => {
		const { store, access, check } = fixture();
		await store.save("toapis", "video-only", now, false, 0);
		await check();
		const queue = await createVideoQueue(
			db,
			access,
			async () => {},
			undefined,
			() => now,
		);
		const review = await queue.review("owner", parse(operation));
		expect(review.quote).toMatchObject({
			status: "unknown",
			reason: "token-usage-unknown",
			advertisedUnitRate: { unit: "million-total-tokens", usd: "10" },
		});
		expect(review.frames).toEqual(
			["Starting frame · frames.example.com", "Ending frame · frames.example.com"].slice(
				0,
				operation.roles.length,
			),
		);
		expect(review.disclosures).toEqual(videoReviewDisclosures(operation));
		expect(review.disclosures.slice(0, -1)).toEqual(keyframeDisclosures);
		expect(review.blockers).toEqual([]);
		expect(JSON.stringify(review)).not.toContain("X-Amz-Signature");
	});

	test("a claim binds the exact frames and stores no frame URL or host", async () => {
		const { store, access, check } = fixture();
		await store.save("toapis", "video-only", now, false, 0);
		const sent: VideoTarget[] = [];
		const queue = await createVideoQueue(
			db,
			access,
			async (_id, _key, send) => {
				sent.push(send);
			},
			undefined,
			() => now,
		);
		const live = parse(interpolate);
		const click = (token: string, input = live, acceptTerms = true) =>
			queue.submit("owner", { ...input, token, acceptTerms });
		// Missing access, missing consent and a stale revision send nothing.
		const unchecked = await queue.review("owner", live);
		expect(await click(unchecked.token)).toMatchObject(staleWithReview);
		await check();
		const review = await queue.review("owner", live);
		expect(await click(review.token, live, false)).toEqual({ error: "invalid" });
		const swapped = parse(interpolate, [
			{ role: "first_frame", url: end },
			{ role: "last_frame", url: start },
		]);
		const replaced = parse(interpolate, [
			{ role: "first_frame", url: start },
			{ role: "last_frame", url: `${end}&v=2` },
		]);
		for (const other of [swapped, replaced, parse(animate)])
			expect(await click(review.token, other)).toEqual({ error: "invalid" });
		await store.save("toapis", "video-only", now, false, 1);
		expect(await click(review.token)).toMatchObject(staleWithReview);
		expect(sent).toHaveLength(0);
		await check();
		const fresh = await queue.review("owner", live);
		const result = await click(fresh.token);
		if (!("jobId" in result)) throw new Error("Missing claim");
		expect(sent).toHaveLength(1);
		expect(sent[0]).toMatchObject({ provider: "toapis", body: live.body });
		expect(await imageJobStore(db).get(result.jobId)).toMatchObject({
			operation: "first-and-last-frame-to-video",
			video_terms: JSON.stringify(videoReviewDisclosures(interpolate)),
		});
		const rows = await durable();
		for (const secret of ["X-Amz-Signature", "frames.example.com", "Drift"])
			expect(rows).not.toContain(secret);
	});

	test("the terms digest binds the keyframe disclosures and quote", async () => {
		const { store, access, check } = fixture();
		await store.save("toapis", "video-only", now, false, 0);
		await check();
		let priced = true;
		const queue = await createVideoQueue(
			db,
			access,
			async () => {},
			async (at) => (priced ? loadStudioPricingFeeds(at) : {}),
			() => now,
		);
		const text = await queue.review("owner", live);
		const keyframe = await queue.review("owner", parse(animate));
		expect(keyframe.token.split(".")[1]).not.toBe(text.token.split(".")[1]);
		priced = false;
		expect(
			await queue.submit("owner", { ...parse(animate), token: keyframe.token, acceptTerms: true }),
		).toMatchObject(staleWithReview);
		expect(await imageJobStore(db).list()).toHaveLength(0);
	});

	test("an identical replay across restart returns the same job after one POST", async () => {
		const { store, access, check } = fixture();
		await store.save("toapis", "video-only", now, false, 0);
		await check();
		let posts = 0;
		const bodies: unknown[] = [];
		const tracker = () =>
			createJobTracking(db, providerStore(db), {
				now: () => now,
				random: () => 0,
				fetch: async (_url, init) => {
					if (init.method !== "POST") return new Response(null, { status: 503 });
					posts++;
					const body = JSON.parse(String(init.body));
					bodies.push(body);
					return Response.json({
						id: "task_frames",
						object: "generation.task",
						model: "seedance-2-5",
						client_business_id: body.client_business_id,
						status: "queued",
					});
				},
			});
		jobs = tracker();
		const live = parse(interpolate);
		const api = await createVideoQueue(db, access, jobs.dispatchVideo, undefined, () => now);
		const review = await api.review("owner", live);
		const click = { ...live, token: review.token, acceptTerms: true };
		const first = await api.submit("owner", click);
		expect(posts).toBe(1);
		expect(bodies[0]).toMatchObject({
			disable_nsfw: false,
			aspect_ratio: "adaptive",
			image_with_roles: [
				{ url: start, role: "first_frame" },
				{ url: end, role: "last_frame" },
			],
		});
		jobs.close();
		await db.close();
		db = await openInstallation(directory);
		jobs = tracker();
		await jobs.resume();
		const restarted = await createVideoQueue(
			db,
			createVideoAccess(db, providerStore(db)),
			jobs.dispatchVideo,
			undefined,
			() => now,
		);
		expect(await restarted.submit("owner", click)).toEqual(first);
		expect(await restarted.submit("owner", { ...click, ...parse(animate) })).toEqual({
			error: "invalid",
		});
		expect(posts).toBe(1);
		expect(await imageJobStore(db).list()).toHaveLength(1);
		expect(await durable()).not.toContain("X-Amz-Signature");
	});
});

describe("Seedance source-video edit", () => {
	const path = "/private/take-3.mp4";
	const query = "?X-Amz-Signature=clip";
	const fragment = "#t=2";
	const source = `https://clips.example.com${path}${query}${fragment}`;
	const parse = (url = source, prompt = "Make it dusk") => {
		const parsed = parseVideo({
			...raw,
			operationKey: seedanceEditOperation.key,
			draft: {
				prompt,
				resolution: "720p",
				generate_audio: true,
				frames: [{ role: "reference_video", url }],
			},
		});
		if (!parsed) throw new Error("Invalid edit fixture.");
		return parsed;
	};
	const durable = async () =>
		JSON.stringify(await db.use((c) => c.all(sql`SELECT * FROM image_job`)));
	async function eligible() {
		const { store, access, check } = fixture();
		await store.save("toapis", "video-only", now, false, 0);
		await check();
		return { store, access, check };
	}

	test("Review quotes the video-input rate and names the source by host only", async () => {
		const { access } = await eligible();
		const queue = await createVideoQueue(
			db,
			access,
			async () => {},
			undefined,
			() => now,
		);
		const review = await queue.review("owner", parse());
		expect(review.quote).toMatchObject({
			status: "unknown",
			reason: "token-usage-unknown",
			advertisedUnitRate: { unit: "million-total-tokens", usd: "6" },
		});
		expect(review.frames).toEqual(["Source clip · clips.example.com"]);
		expect(review.disclosures).toEqual([
			...editDisclosures,
			"Gallery saves complete H.264/AAC MP4 files up to 30 seconds, the upstream model's documented maximum for this mode, unverified on this route, plus 1 second for container rounding, within its size and dimension limits. A completed billable clip outside them stays with the provider.",
		]);
		expect(review.blockers).toEqual([]);
		const serialized = JSON.stringify(review);
		for (const part of [source, path, "take-3", query, "X-Amz-Signature", fragment])
			expect(serialized).not.toContain(part);
	});

	test("a missing or 30-day-stale feed shows no rate", async () => {
		const { access } = await eligible();
		const missing = await createVideoQueue(
			db,
			access,
			async () => {},
			async () => ({}),
			() => now,
		);
		const stale = await createVideoQueue(
			db,
			access,
			async () => {},
			undefined,
			() => now,
		);
		for (const [queue, reason] of [
			[missing, "missing-feed"],
			[stale, "expired-feed"],
		] as const) {
			// The bundled observation is more than 30 days old.
			if (reason === "expired-feed") now = Date.parse(toapisBundle.observedAt) + 31 * 86_400_000;
			const review = await queue.review("owner", parse());
			expect(review.quote).toMatchObject({ status: "unknown", reason });
			expect(review.quote).not.toHaveProperty("advertisedUnitRate");
		}
	});

	test("a claim binds the exact source and stores no URL, host or prompt", async () => {
		const { store, access, check } = fixture();
		await store.save("toapis", "video-only", now, false, 0);
		const sent: VideoTarget[] = [];
		const queue = await createVideoQueue(
			db,
			access,
			async (_id, _key, send) => {
				sent.push(send);
			},
			undefined,
			() => now,
		);
		const live = parse();
		const click = (token: string, input = live, acceptTerms = true) =>
			queue.submit("owner", { ...input, token, acceptTerms });
		// Missing access, missing consent, a replaced URL and a stale revision send nothing.
		const unchecked = await queue.review("owner", live);
		expect(await click(unchecked.token)).toMatchObject(staleWithReview);
		await check();
		const review = await queue.review("owner", live);
		expect(await click(review.token, live, false)).toEqual({ error: "invalid" });
		for (const other of [
			parse(`https://clips.example.com${path}?X-Amz-Signature=other`),
			parse(`https://other.example.com${path}${query}`),
		])
			expect(await click(review.token, other)).toEqual({ error: "invalid" });
		await store.save("toapis", "video-only", now, false, 1);
		expect(await click(review.token)).toMatchObject(staleWithReview);
		expect(sent).toHaveLength(0);
		await check();
		const fresh = await queue.review("owner", live);
		const result = await click(fresh.token);
		if (!("jobId" in result)) throw new Error("Missing claim");
		expect(sent).toHaveLength(1);
		expect(sent[0]).toMatchObject({ provider: "toapis", body: live.body });
		expect(await imageJobStore(db).get(result.jobId)).toMatchObject({
			operation: "video-edit",
			video_terms: JSON.stringify(videoReviewDisclosures(seedanceEditOperation)),
			save_seconds: 30,
		});
		const rows = await durable();
		for (const secret of ["X-Amz-Signature", "clips.example.com", "take-3", "Make it dusk"])
			expect(rows).not.toContain(secret);
	});

	test("the terms digest binds the edit disclosures and quote, and feed expiry after Review is stale", async () => {
		const { access } = await eligible();
		let priced = true;
		const queue = await createVideoQueue(
			db,
			access,
			async () => {},
			async (at) => (priced ? loadStudioPricingFeeds(at) : {}),
			() => now,
		);
		const [animate] = seedanceKeyframeOperations;
		const keyframe = await queue.review(
			"owner",
			parseVideo({
				...raw,
				operationKey: animate.key,
				draft: {
					prompt: "Make it dusk",
					duration: 5,
					resolution: "720p",
					generate_audio: true,
					frames: [{ role: "first_frame", url: source }],
				},
			}) ?? live,
		);
		const edit = await queue.review("owner", parse());
		expect(edit.token.split(".")[1]).not.toBe(keyframe.token.split(".")[1]);
		priced = false;
		expect(
			await queue.submit("owner", { ...parse(), token: edit.token, acceptTerms: true }),
		).toMatchObject(staleWithReview);
		priced = true;
		const reviewed = await queue.review("owner", parse());
		now += 31 * 86400_000;
		expect(
			await queue.submit("owner", { ...parse(), token: reviewed.token, acceptTerms: true }),
		).toMatchObject(staleWithReview);
		expect(await imageJobStore(db).list()).toHaveLength(0);
	});

	test("an identical replay across restart returns the same job after one POST", async () => {
		const { access } = await eligible();
		let posts = 0;
		const bodies: unknown[] = [];
		const tracker = () =>
			createJobTracking(db, providerStore(db), {
				now: () => now,
				random: () => 0,
				fetch: async (_url, init) => {
					if (init.method !== "POST") return new Response(null, { status: 503 });
					posts++;
					const body = JSON.parse(String(init.body));
					bodies.push(body);
					return Response.json({
						id: "task_edit",
						object: "generation.task",
						model: "seedance-2-5",
						client_business_id: body.client_business_id,
						status: "queued",
					});
				},
			});
		jobs = tracker();
		const live = parse();
		const api = await createVideoQueue(db, access, jobs.dispatchVideo, undefined, () => now);
		const review = await api.review("owner", live);
		const click = { ...live, token: review.token, acceptTerms: true };
		const first = await api.submit("owner", click);
		expect(posts).toBe(1);
		expect(bodies[0]).toEqual({
			...live.body,
			client_business_id: expect.stringMatching(/^siluet-/),
		});
		expect(bodies[0]).toMatchObject({
			video_operation: "edit",
			duration: -1,
			aspect_ratio: "adaptive",
			disable_nsfw: false,
			video_with_roles: [{ url: source, role: "reference_video" }],
		});
		expect(bodies[0]).not.toHaveProperty("image_with_roles");
		jobs.close();
		await db.close();
		db = await openInstallation(directory);
		jobs = tracker();
		await jobs.resume();
		const restarted = await createVideoQueue(
			db,
			createVideoAccess(db, providerStore(db)),
			jobs.dispatchVideo,
			undefined,
			() => now,
		);
		expect(await restarted.submit("owner", click)).toEqual(first);
		expect(await restarted.submit("owner", { ...click, ...parse(`${source}&v=2`) })).toEqual({
			error: "invalid",
		});
		expect(posts).toBe(1);
		expect(await imageJobStore(db).list()).toHaveLength(1);
		expect(await durable()).not.toContain("X-Amz-Signature");
	});
});
