// ToAPIs Seedream Queue gates read the inventory snapshot (docs/SPEC-catalog-engine.md, Check 11).
import { afterEach, beforeEach, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { sql } from "drizzle-orm";
import { createOwnerDirectory } from "../../../../../tests/fixtures/owner-directory";
import { createSeedreamDraft } from "../../../shared/image-studio/seedream";
import { inventoryFreshMs, skippedText, staleText } from "../../../shared/providers/inventory";
import { imageBatchStore } from "../../db/image-batch-store";
import { type Installation, openInstallation } from "../../db/installation";
import { providerStore } from "../../db/provider-store";
import { createInventory } from "../providers/inventory";
import type { BatchAuthorization } from "./batch-dispatch";
import { parseQueueRequest } from "./request";
import { createSubmissionQueue } from "./submission";

const referenceUrl = "https://images.example.org/reference.png";
let db: Installation;
let dir: string;
let now: number;
let reads: string[];
let reply: () => Promise<Response>;
let posted: string[];
let batches: BatchAuthorization[];
const listing = (...ids: string[]) =>
	Response.json({ success: true, object: "list", data: ids.map((id) => ({ id })) });
const unreachable = async (): Promise<Response> => {
	throw Object.assign(new TypeError("fixture connect failure"), { code: "ECONNREFUSED" });
};
/** A plain subset: Bun's toMatchObject rewrites the received value at an asymmetric matcher. */
const staleWithReview = { error: "stale", review: {} };

beforeEach(async () => {
	dir = await createOwnerDirectory();
	db = await openInstallation(dir);
	now = 1_800_000_000_000;
	reads = [];
	posted = [];
	batches = [];
	reply = async () => listing("doubao-seedream-5-5");
});
afterEach(async () => {
	await db.close();
	await rm(dir, { recursive: true, force: true });
});

function makeInput(urls: string[] = [], count = 1, retryLimit = 0) {
	const draft = createSeedreamDraft("toapis", urls.length ? "edit" : "generate");
	draft.references = urls.map((url) => ({ kind: "url", url, hostname: "images.example.org" }));
	const parsed = parseQueueRequest({
		draft: { ...draft, prompt: "a folded paper crane" },
		count,
		retryLimit,
		acceptUnknown: false,
	});
	if (!parsed) throw new Error("Invalid fixture.");
	return parsed;
}

async function setup(seedream = false) {
	const store = providerStore(db);
	await store.save("toapis", "fixture-toapis", now, seedream, 0);
	const inventory = createInventory(db, store, {
		read: async (url) => {
			reads.push(url);
			return reply();
		},
		now: () => now,
		elapsed: () => now,
	});
	const queue = await createSubmissionQueue(
		db,
		store.credential,
		{
			dispatch: async (_id, _provider, key) => {
				posted.push(key);
			},
			dispatchBatch: async (auth) => {
				batches.push(auth);
			},
		},
		async () => ({}),
		() => now,
		undefined,
		undefined,
		{ inventory },
	);
	const reviewed = async (input = makeInput()) => {
		const review = await queue.review("owner", input);
		if (!("token" in review)) throw new Error("Expected a Review.");
		return {
			review,
			click: () => queue.submit("owner", { ...input, token: review.token, acceptUnknown: true }),
		};
	};
	return { store, inventory, queue, reviewed };
}

test.each([
	["text-to-image", []],
	["a URL edit", [referenceUrl]],
] as const)("a fresh listing queues %s under a key without the Seedream flag", async (_, urls) => {
	const { inventory, reviewed } = await setup();
	await inventory.check("image");
	const { review, click } = await reviewed(makeInput([...urls]));
	expect(review.access).toEqual({
		state: "listed",
		text: expect.stringMatching(/^ToAPIs listed doubao-seedream-5-5 for this key at /),
	});
	expect(review.blockers).toEqual([]);
	expect(await click()).toHaveProperty("jobId");
	expect(posted).toEqual(["fixture-toapis"]);
});

test.each([
	["absent", async () => listing("doubao-seedream-5-0"), "ToAPIs did not list"],
	["failed", async () => new Response(null, { status: 401 }), "The ToAPIs model check failed at"],
] as const)("an %s snapshot blocks Queue with zero POSTs", async (_, response, text) => {
	const { inventory, reviewed } = await setup(true);
	reply = response;
	await inventory.check("image");
	const { review, click } = await reviewed();
	expect(review.access?.text).toStartWith(text);
	expect(review.blockers).toEqual([String(review.access?.text)]);
	expect(await click()).toMatchObject(staleWithReview);
	expect(posted).toEqual([]);
});

test("a stale snapshot is unknown; an unreachable automatic check is skipped and records nothing", async () => {
	const { inventory, reviewed } = await setup();
	await inventory.check("image");
	now += inventoryFreshMs;
	reply = unreachable;
	const { review, click } = await reviewed();
	expect(reads).toHaveLength(2);
	expect(review.access).toEqual({ state: "stale", text: skippedText });
	const refused = await click();
	expect(refused).toMatchObject(staleWithReview);
	// The stale answer's fresh Review only reads.
	expect(reads).toHaveLength(2);
	if ("review" in refused && refused.review && "access" in refused.review)
		expect(refused.review.access?.text).toBe(staleText);
	expect(posted).toEqual([]);
});

test("another revision's snapshot leaves the model unknown", async () => {
	const { store, inventory, reviewed } = await setup();
	await inventory.check("image");
	await store.save("toapis", "fixture-replaced", now, false, 1);
	const { review, click } = await reviewed();
	expect(review.access?.state).toBe("unchecked");
	expect(await click()).toMatchObject(staleWithReview);
	expect(posted).toEqual([]);
});

test("a Check again between Review and Queue, or 24 hours passing, makes the Review stale", async () => {
	const { inventory, reviewed } = await setup();
	await inventory.check("image");
	const first = await reviewed();
	now += 1000;
	await inventory.check("image");
	expect(await first.click()).toMatchObject(staleWithReview);
	const second = await reviewed();
	now += inventoryFreshMs;
	const refused = await second.click();
	expect(refused).toMatchObject(staleWithReview);
	expect(reads).toHaveLength(2);
	expect(posted).toEqual([]);
	const reopened = await reviewed();
	expect(reads).toHaveLength(3);
	expect(await reopened.click()).toHaveProperty("jobId");
	expect(posted).toHaveLength(1);
});

test("the Seedream exception queues before any snapshot and never revives after a failed one", async () => {
	const { inventory, reviewed } = await setup(true);
	const first = await reviewed();
	expect(first.review.access).toEqual({
		state: "exception",
		text: "The global image model list included this model for this key.",
	});
	expect(await first.click()).toHaveProperty("jobId");
	reply = async () => new Response(null, { status: 503 });
	await inventory.check("image");
	const second = await reviewed();
	expect(second.review.access?.state).toBe("failed");
	expect(await second.click()).toMatchObject(staleWithReview);
	expect(posted).toHaveLength(1);
});

test("a batch queues under a listed key without the Seedream flag, and a later Check again does not stop it", async () => {
	const { inventory, reviewed } = await setup();
	await inventory.check("image");
	const { click } = await reviewed(makeInput([], 2, 1));
	const claimed = await click();
	if (!("jobId" in claimed)) throw new Error("Expected a batch claim.");
	expect(batches).toHaveLength(1);
	const [auth] = batches;
	now += 1000;
	await inventory.check("image");
	const current = await auth.checkTerms();
	expect(current()).toBe(true);
	expect(await imageBatchStore(db).reserve(auth.id, 1, () => now, current)).toHaveProperty("jobId");
	// Only the claimed credential revision may reserve.
	await providerStore(db).save("toapis", "fixture-replaced", now, false, 1);
	expect(await imageBatchStore(db).reserve(auth.id, 2, () => now, current)).toEqual({
		stop: "terms",
	});
});

test("an absent snapshot blocks a batch claim", async () => {
	const { inventory, reviewed } = await setup(true);
	reply = async () => listing();
	await inventory.check("image");
	const { click } = await reviewed(makeInput([], 2, 0));
	expect(await click()).toMatchObject(staleWithReview);
	expect(batches).toEqual([]);
});

test("a ToAPIs image job under a key without the Seedream flag stays readable for status and Save", async () => {
	const { inventory, reviewed, store } = await setup();
	await inventory.check("image");
	const claimed = await (await reviewed()).click();
	if (!("jobId" in claimed)) throw new Error("Expected a claim.");
	const readable = await store.jobReadability();
	expect(readable({ provider: "toapis", model: "doubao-seedream-5-5", revision: 1 })).toBe(true);
	expect(await store.credential("toapis", 1, "toapis-image")).toEqual({
		key: "fixture-toapis",
		revision: 1,
	});
	// The job still needs the key, so changing it asks for the warning first.
	await db.use((conn) =>
		conn.run(sql`UPDATE image_job SET state='running' WHERE id=${claimed.jobId}`),
	);
	expect(await store.save("toapis", "fixture-other", now, false, 1, true)).toBe("job-warning");
});
