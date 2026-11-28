// qwen-image-2.1 qualifies booleans (`prompt_extend`) and integers (`seed`) for the Poyo.ai image
// family (catalog engine spec, "Families and admission"; D2 "Verification by contract family").
// Each D2 case runs a derived Review and Queue whose body carries both, through the shipped
// tracking, automatic Save and Gallery. Every provider response is an offline fixture.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { sql } from "drizzle-orm";
import { createOwnerDirectory } from "../../../../../tests/fixtures/owner-directory";
import { referencePng } from "../../../../../tests/fixtures/reference-image";
import { createDerivedDraft } from "../../../shared/image-studio/derived";
import { queueRowFor } from "../../../shared/media-catalog/image-queue";
import type { QueueRow } from "../../../shared/media-catalog/queue-row";
import { providerStore } from "../../db/provider-store";
import { openRuntimeInstallation, type RuntimeInstallation } from "../../db/runtime-installation";
import { saveIntentStore } from "../../db/save-intent";
import type { CheckFetch } from "../../providers/connection-check";
import { createAutoSave } from "../gallery/auto-save";
import type { Transport } from "../gallery/download";
import { createGallery } from "../gallery/gallery";
import { createJobTracking } from "../jobs/tracking";
import { parseDerivedRequest } from "./derived";
import { createSubmissionQueue } from "./submission";

const start = 1_800_000_000_000;
const credential = "fixture-qwen-key";
const taskId = "qwen-task-1";
const resultUrl = "https://cdn.example.net/qwen-result.png?sig=signed-result-sentinel";
const prompt = "A glass lantern on a mossy stone, morning mist";
const key = {
	provider: "poyo",
	model: "qwen-image-2.1",
	route: "POST /api/generate/submit",
	operation: "text-to-image",
} as const;
const options = {
	background: "opaque",
	output_format: "png",
	prompt_extend: false,
	resolution: "1K",
	seed: 42,
	size: "1:1",
} as const;
const body = { model: key.model, input: { prompt, ...options, enable_safety_checker: false } };

let now: number;
let directory: string;
let installation: RuntimeInstallation;
let runtime: Awaited<ReturnType<typeof open>> | undefined;
let posts: unknown[];
let reads: number;
let transfers: number;
let submit: () => Response;
let status: () => Response;
let media: () => Response;

const finished = () =>
	Response.json({
		code: 200,
		data: {
			task_id: taskId,
			status: "finished",
			files: [{ file_type: "image", file_url: resultUrl }],
		},
	});
const fetch: CheckFetch = async (url, init) => {
	if (url.endsWith("/api/user/balance"))
		return Response.json({ code: 200, data: { credits_amount: 10 } });
	if (init.method === "POST") {
		posts.push(JSON.parse(String(init.body)));
		return submit();
	}
	reads++;
	return status();
};
const transport: Transport = {
	resolve: async () => "93.184.216.34",
	request: async () => {
		transfers++;
		return media();
	},
};

beforeEach(async () => {
	now = start;
	posts = [];
	reads = 0;
	transfers = 0;
	submit = () => Response.json({ code: 200, data: { task_id: taskId } });
	status = () => Response.json({ code: 200, data: { task_id: taskId, status: "running" } });
	media = () => new Response(referencePng, { headers: { "content-type": "image/png" } });
	directory = await createOwnerDirectory();
	installation = await openRuntimeInstallation(directory);
	// A balance-verified key without the Seedream check serves every derived row.
	await providerStore(installation).save("poyo", credential, now, false, 0);
});
afterEach(async () => {
	await runtime?.close();
	runtime = undefined;
	await installation.close();
	await rm(directory, { recursive: true, force: true });
});

async function open() {
	const store = providerStore(installation);
	const jobs = createJobTracking(installation, store, {
		fetch,
		now: () => now,
		random: () => 0,
		scheduleRead: () => () => {},
		onDelivery: (id, delivery) => autoSave.deliver(id, delivery),
	});
	const autoSave = createAutoSave(installation, {
		readForSave: jobs.readForSave,
		readability: store.jobReadability,
		now: () => now,
		transport,
	});
	const gallery = createGallery(installation);
	const queue = await createSubmissionQueue(
		installation,
		store.credential,
		jobs,
		async () => ({}),
		() => now,
	);
	await gallery.recover();
	await saveIntentStore(installation).clearAbandoned();
	await jobs.resume();
	autoSave.start();
	return {
		jobs,
		autoSave,
		gallery,
		queue,
		async close() {
			jobs.close();
			await autoSave.close();
		},
	};
}
const settle = async () => {
	await Bun.sleep(5);
	await runtime?.autoSave.idle();
};
const request = (token?: string) => ({
	draft: { ...createDerivedDraft(queueRowFor(key) as QueueRow, prompt), options },
	operationKey: key,
	count: 1,
	retryLimit: 0,
	acceptUnknown: token !== undefined,
	...(token !== undefined && { token }),
});
/** Review, accept the unknown price and Queue: one claim, its dispatch awaited. */
async function queueOnce() {
	if (!runtime) throw new Error("No runtime.");
	const reviewed = parseDerivedRequest(request(), "review");
	if (!reviewed) throw new Error("The qwen draft does not review.");
	const review = await runtime.queue.review("owner", reviewed);
	if (!("token" in review)) throw new Error(`No Review: ${JSON.stringify(review)}`);
	const click = parseDerivedRequest(request(review.token), "submit");
	if (!click) throw new Error("The click does not parse.");
	const claimed = await runtime.queue.submit("owner", click);
	if (!("jobId" in claimed)) throw new Error(`No claim: ${JSON.stringify(claimed)}`);
	return { id: claimed.jobId, click };
}
const summary = async (id: string) => (await runtime?.jobs.list())?.find((job) => job.id === id);

test("qwen-image-2.1 queues once on the derived path, with prompt_extend and seed in the body", () => {
	const row = queueRowFor(key);
	expect(row?.fields.map(({ wire, kind }) => [wire, kind])).toEqual([
		["background", "enum"],
		["output_format", "enum"],
		["prompt_extend", "boolean"],
		["resolution", "enum"],
		["seed", "integer"],
		["size", "enum"],
	]);
	expect(row?.combinations).toEqual([
		{ when: { background: "transparent" }, refuses: { output_format: ["jpeg"] } },
	]);
	expect(row?.count).toBeNull();
});

test("acceptance: one POST, then the completed image saves to Gallery", async () => {
	runtime = await open();
	const { id } = await queueOnce();
	expect(posts).toEqual([body]);
	expect(await summary(id)).toMatchObject({ state: "waiting", taskId });
	status = finished;
	now += 10_000;
	await runtime.jobs.refresh(id);
	await settle();
	expect(await summary(id)).toMatchObject({ state: "completed", library: "saved" });
	expect(transfers).toBe(1);
	expect(posts).toHaveLength(1);
});

test("confirmed rejection: one POST, the job is rejected and nothing is resent", async () => {
	submit = () => Response.json({ code: 400, error: { type: "validation_error" } });
	runtime = await open();
	const { id } = await queueOnce();
	expect(await summary(id)).toMatchObject({ state: "rejected", retryable: false });
	await runtime.close();
	await installation.close();
	installation = await openRuntimeInstallation(directory);
	runtime = await open();
	expect(posts).toEqual([body]);
});

test("uncertain submission: an unreadable answer leaves the job unknown and it is never resubmitted", async () => {
	submit = () => new Response("upstream", { status: 502 });
	runtime = await open();
	const { id } = await queueOnce();
	expect(await summary(id)).toMatchObject({ state: "unknown" });
	await runtime.close();
	await installation.close();
	installation = await openRuntimeInstallation(directory);
	runtime = await open();
	now += 60_000;
	await runtime.jobs.refresh(id);
	expect(posts).toEqual([body]);
	expect(reads).toBe(0);
});

test("throttling: the limiter's answer closes the submit gate and the job is not sent again", async () => {
	submit = () =>
		Response.json(
			{ code: 429, error: { type: "rate_limit_error", message: "fixture limiter" } },
			{ status: 429, headers: { "retry-after": "30" } },
		);
	runtime = await open();
	const { id } = await queueOnce();
	expect(await summary(id)).toMatchObject({ state: "unknown", throttled: true });
	const gate = await installation.use((db) =>
		db.get<{ submit_after: number }>(
			sql`SELECT submit_after FROM provider_gate WHERE provider='poyo'`,
		),
	);
	expect(gate?.submit_after).toBeGreaterThanOrEqual(now + 30_000);
	expect(posts).toEqual([body]);
});

test("expiry: automatic reads stop at the polling window, and Refresh still reads the same task", async () => {
	runtime = await open();
	const { id } = await queueOnce();
	now += 121_000;
	await runtime.jobs.resume();
	expect(await summary(id)).toMatchObject({ state: "waiting", canRefresh: true });
	expect(reads).toBe(0);
	status = finished;
	await runtime.jobs.refresh(id);
	await settle();
	expect(reads).toBe(1);
	expect(await summary(id)).toMatchObject({ state: "completed", library: "saved" });
	expect(posts).toHaveLength(1);
});

test("failed download: three CDN failures end in Download failed with Retry download, no POST", async () => {
	media = () => new Response(null, { status: 404 });
	runtime = await open();
	const { id } = await queueOnce();
	status = finished;
	now += 10_000;
	await runtime.jobs.refresh(id);
	await settle();
	for (const wait of [30_000, 120_000]) {
		now += wait;
		runtime.autoSave.start();
		await settle();
	}
	expect(transfers).toBe(3);
	expect(await summary(id)).toMatchObject({ library: "failed", retryable: true });
	media = () => new Response(referencePng, { headers: { "content-type": "image/png" } });
	expect(await runtime.autoSave.retry(id)).toBe(true);
	await settle();
	expect(await summary(id)).toMatchObject({ library: "saved" });
	expect(posts).toHaveLength(1);
});

test("replay across restart: the same click returns the same job with no second POST", async () => {
	runtime = await open();
	const { id, click } = await queueOnce();
	await runtime.close();
	await installation.close();
	installation = await openRuntimeInstallation(directory);
	runtime = await open();
	expect(await runtime.queue.submit("owner", click)).toEqual({ jobId: id });
	expect(await runtime.queue.submit("other", click)).toEqual({ error: "invalid" });
	expect(posts).toEqual([body]);
});
