// A ToAPIs Seedream file edit queues only on a fresh listing (docs/SPEC-catalog-engine.md, Check 11).
import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import { createOwnerDirectory } from "../../../../../tests/fixtures/owner-directory";
import { createSeedreamDraft } from "../../../shared/image-studio/seedream";
import { inventoryFreshMs } from "../../../shared/providers/inventory";
import { claimOwner } from "../../db/owner-session.fixture";
import { providerStore } from "../../db/provider-store";
import type { RuntimeInstallation } from "../../db/runtime-installation";
import { openRuntimeInstallation } from "../../db/runtime-installation";
import { createInventory } from "../providers/inventory";
import { fileDispatcher } from "./dispatch";
import { createFileQueue } from "./queue";
import { clickFor, orderedBody, parsedRequest } from "./request.fixture";
import { openTestStages } from "./stages.fixture";

let root: string;
let db: RuntimeInstallation;
let stages: Awaited<ReturnType<typeof openTestStages>>;
let clock: number;
let reply: () => Promise<Response>;
let sent: string[];
const scope = { owner: "creator", session: "session-digest", draft: crypto.randomUUID() };
const listing = (...ids: string[]) =>
	Response.json({ success: true, object: "list", data: ids.map((id) => ({ id })) });

beforeEach(async () => {
	root = await createOwnerDirectory();
	db = await openRuntimeInstallation(root);
	stages = await openTestStages(db);
	clock = Date.now();
	sent = [];
	reply = async () => listing("doubao-seedream-5-5");
	await claimOwner(db, scope.owner, scope.session, clock);
});
afterEach(async () => {
	await stages.close();
	await db.close();
	await rm(root, { recursive: true, force: true });
});

async function setup(seedream = false) {
	const credentials = providerStore(db);
	await credentials.save("toapis", "fixture-toapis", clock, seedream, 0);
	const inventory = createInventory(db, credentials, { read: () => reply(), now: () => clock });
	const dispatch = fileDispatcher(db, "runtime", () => {}, {
		pin: async () => async () => {
			throw new Error("unexpected transport");
		},
		balance: async () => "12",
		async upload(_provider, key) {
			sent.push(`upload ${key}`);
			return { kind: "ready", url: "https://storage.example.org/ref" };
		},
		async edit(_provider, key) {
			sent.push(`edit ${key}`);
			return { kind: "accepted", taskId: "fixture-id" };
		},
	});
	const api = await createFileQueue(db, "runtime", stages, credentials.credential, dispatch, {
		loadFeeds: async () => ({}),
		now: () => clock,
		inventory,
	});
	const bytes = new Uint8Array([4, 2]);
	const stage = await stages.put(scope, {
		bytes,
		digest: createHash("sha256").update(bytes).digest("hex"),
		size: bytes.length,
		mime: "image/png",
		transform: "none",
		revision: 0,
		rotated: false,
	});
	const draft = { ...createSeedreamDraft("toapis", "edit"), prompt: "Draw a quiet harbour" };
	const request = parsedRequest(orderedBody(draft, [stage]));
	const reviewed = async () => {
		const review = await api.review(scope, request);
		if (!("token" in review)) throw new Error("Missing file Review");
		return { review, click: () => api.submit(scope, clickFor(request, review)) };
	};
	return { api, inventory, reviewed, credentials };
}

const settle = async () => {
	for (let attempt = 0; attempt < 50 && sent.length < 2; attempt++) await Bun.sleep(10);
};

test("a listed key without the Seedream flag reviews its access line and queues the file edit", async () => {
	const { api, inventory, reviewed } = await setup();
	await inventory.check("image");
	const { review, click } = await reviewed();
	expect(review.access).toEqual({
		state: "listed",
		text: expect.stringMatching(/^ToAPIs listed doubao-seedream-5-5 for this key at /),
	});
	expect(review.blockers).toEqual([]);
	expect(await click()).toHaveProperty("jobId");
	await settle();
	expect(sent).toEqual(["upload fixture-toapis", "edit fixture-toapis"]);
	await api.close();
});

test.each([
	["absent", async () => listing("doubao-seedream-5-0"), 0],
	["failed", async () => new Response(null, { status: 503 }), 0],
	["stale", async () => listing("doubao-seedream-5-5"), inventoryFreshMs],
] as const)("an %s snapshot uploads zero bytes and sends nothing", async (_, response, age) => {
	const { api, inventory, reviewed } = await setup(true);
	reply = response;
	await inventory.check("image");
	const { review, click } = await reviewed();
	clock += age;
	expect(await click()).toEqual({ error: "stale" });
	if (age === 0) expect(review.blockers).toEqual([String(review.access?.text)]);
	expect(sent).toEqual([]);
	await api.close();
});

test("a Check again between Review and Queue makes the file Review stale", async () => {
	const { api, inventory, reviewed } = await setup();
	await inventory.check("image");
	const { click } = await reviewed();
	clock += 1000;
	await inventory.check("image");
	expect(await click()).toEqual({ error: "stale" });
	expect(sent).toEqual([]);
	await api.close();
});

test("the Seedream exception queues a file edit before any snapshot", async () => {
	const { api, reviewed } = await setup(true);
	const { review, click } = await reviewed();
	expect(review.access?.state).toBe("exception");
	expect(await click()).toHaveProperty("jobId");
	await settle();
	expect(sent).toHaveLength(2);
	await api.close();
});

test("a stale successful snapshot gets one automatic check when the file Review opens", async () => {
	const { api, inventory, reviewed } = await setup();
	let reads = 0;
	reply = async () => {
		reads++;
		return listing("doubao-seedream-5-5");
	};
	await inventory.check("image");
	clock += inventoryFreshMs;
	const { review, click } = await reviewed();
	expect(reads).toBe(2);
	expect(review.access?.state).toBe("listed");
	expect(await click()).toHaveProperty("jobId");
	await api.close();
});
