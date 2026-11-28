import { afterEach, beforeEach, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { sql } from "drizzle-orm";
import { createOwnerDirectory } from "../../../../../tests/fixtures/owner-directory";
import { inventoryFreshMs } from "../../../shared/providers/inventory";
import { type Installation, openInstallation } from "../../db/installation";
import { inventoryStore } from "../../db/inventory-store";
import { providerStore } from "../../db/provider-store";
import type { CheckFetch } from "../../providers/connection-check";
import { createInventory } from "./inventory";

const origin = "https://toapis.com";
const seedream = {
	provider: "toapis",
	model: "doubao-seedream-5-5",
	route: "POST /v1/images/generations",
	operation: "text-to-image",
};
const list = (...ids: string[]) =>
	Response.json({
		success: true,
		object: "list",
		data: ids.map((id) => ({ id, object: "model" })),
	});

let directory: string;
let db: Installation;
let now: number;
let elapsed: number;
let calls: { url: string; init: RequestInit }[];
let reply: (url: string) => Promise<Response>;

beforeEach(async () => {
	directory = await createOwnerDirectory();
	db = await openInstallation(directory);
	now = 1_800_000_000_000;
	elapsed = 0;
	calls = [];
	reply = async () => list("doubao-seedream-5-5", "seedance-2-5");
});
afterEach(async () => {
	await db.close();
	await rm(directory, { recursive: true, force: true });
});

function setup() {
	const store = providerStore(db);
	const read: CheckFetch = async (url, init) => {
		calls.push({ url, init });
		return reply(url);
	};
	const inventory = createInventory(db, store, {
		read,
		now: () => now,
		elapsed: () => elapsed,
	});
	return { store, inventory, snapshots: inventoryStore(db) };
}
const unreachable = async (): Promise<Response> => {
	throw Object.assign(new TypeError("fixture connect failure"), { code: "ECONNREFUSED" });
};

test("Check again records the listing, and a fourth check in a minute sends nothing", async () => {
	const { store, inventory, snapshots } = setup();
	await store.save("toapis", "fixture-key", now, false, 0);
	for (let attempt = 0; attempt < 3; attempt++)
		expect(await inventory.check("image")).toMatchObject({ outcome: "recorded" });
	expect(await inventory.check("image")).toEqual({ outcome: "rate-limited", retryAfter: 60 });
	expect(calls).toHaveLength(3);
	// Each scope has its own limit.
	expect(await inventory.check("video")).toMatchObject({ outcome: "recorded" });
	elapsed += 60_001;
	expect(await inventory.check("image")).toMatchObject({ outcome: "recorded" });
	expect(calls.map(({ url }) => url)).toEqual([
		`${origin}/v1/models?type=image`,
		`${origin}/v1/models?type=image`,
		`${origin}/v1/models?type=image`,
		`${origin}/v1/models?type=video`,
		`${origin}/v1/models?type=image`,
	]);
	expect(calls.every(({ init }) => init.method === "GET" && init.body === undefined)).toBe(true);
	expect(await snapshots.current(origin, "image")).toMatchObject({
		outcome: "succeeded",
		models: ["doubao-seedream-5-5", "seedance-2-5"],
	});
});

test("with no readable key a check makes no request and records nothing", async () => {
	const { inventory, snapshots } = setup();
	expect(await inventory.check("image")).toEqual({ outcome: "disconnected" });
	expect(await inventory.check("video", "automatic")).toEqual({ outcome: "disconnected" });
	expect(calls).toHaveLength(0);
	expect(await snapshots.current(origin, "image")).toBeNull();
});

test("an unreachable host skips an automatic check and records a manual one as failed", async () => {
	const { store, inventory, snapshots } = setup();
	await store.save("toapis", "fixture-key", now, true, 0);
	reply = unreachable;
	expect(await inventory.check("image", "automatic")).toEqual({ outcome: "skipped" });
	expect(await snapshots.current(origin, "image")).toBeNull();
	expect(await inventory.check("image")).toMatchObject({ outcome: "recorded" });
	expect(await snapshots.current(origin, "image")).toMatchObject({ outcome: "unavailable" });
});

test.each([
	["a redirect", () => new Response(null, { status: 302, headers: { location: "/x" } })],
	["a 403", () => new Response(null, { status: 403 })],
	["a 429", () => new Response(null, { status: 429 })],
])("%s is recorded as a failed check, even when automatic", async (_, response) => {
	const { store, inventory, snapshots } = setup();
	await store.save("toapis", "fixture-key", now, true, 0);
	reply = async () => {
		const answer = response();
		// A real fetch with redirect: "error" rejects on a 3xx.
		if (answer.status === 302)
			throw Object.assign(new TypeError("redirect"), { code: "UnexpectedRedirect" });
		return answer;
	};
	expect(await inventory.check("image", "automatic")).toMatchObject({ outcome: "recorded" });
	expect((await snapshots.current(origin, "image"))?.outcome).toBe(
		response().status === 403 ? "rejected" : "unavailable",
	);
});

test("an automatic check joins one in flight only for the same revision", async () => {
	const { store, inventory, snapshots } = setup();
	await store.save("toapis", "fixture-key", now, true, 0);
	const answers: PromiseWithResolvers<Response>[] = [];
	reply = () => {
		const answer = Promise.withResolvers<Response>();
		answers.push(answer);
		return answer.promise;
	};
	const sentAll = async (count: number) => {
		while (calls.length < count) await Bun.sleep(1);
	};
	const manual = inventory.check("image");
	await sentAll(1);
	const joined = inventory.check("image", "automatic");
	await Bun.sleep(20);
	expect(calls).toHaveLength(1);
	answers[0].resolve(list("doubao-seedream-5-5"));
	expect(await manual).toMatchObject({ outcome: "recorded" });
	expect(await joined).toEqual(await manual);

	// A key replaced mid-check never joins the old check, and the old answer writes nothing.
	const old = inventory.check("image");
	await sentAll(2);
	await store.save("toapis", "fixture-replaced", now, true, 1);
	const replaced = inventory.check("image", "automatic");
	await sentAll(3);
	answers[2].resolve(list("fixture-new"));
	answers[1].resolve(list("fixture-old"));
	expect(await replaced).toMatchObject({ outcome: "recorded" });
	expect(await old).toEqual({ outcome: "superseded" });
	expect(await snapshots.current(origin, "image")).toMatchObject({
		revision: 2,
		models: ["fixture-new"],
	});
});

test("Review runs one automatic check only on a stale successful snapshot", async () => {
	const { store, inventory } = setup();
	await store.save("toapis", "fixture-key", now, false, 0);
	// No snapshot: the manual flow stays; nothing is sent.
	expect((await inventory.review(seedream, "image")).access.state).toBe("unchecked");
	expect(calls).toHaveLength(0);
	await inventory.check("image");
	expect((await inventory.review(seedream, "image")).access.state).toBe("listed");
	expect(calls).toHaveLength(1);
	now += inventoryFreshMs;
	const refreshed = await inventory.review(seedream, "image");
	expect(refreshed).toEqual({
		access: { state: "listed", revision: 1, checkedAt: now, basis: "snapshot" },
		skipped: false,
	});
	expect(calls).toHaveLength(2);
	// A failed snapshot is never retried automatically.
	reply = async () => new Response(null, { status: 500 });
	await inventory.check("image");
	now += inventoryFreshMs;
	expect((await inventory.review(seedream, "image")).access.state).toBe("failed");
	expect(calls).toHaveLength(3);
});

test("a stale Review whose automatic check cannot reach ToAPIs stays stale and records nothing", async () => {
	const { store, inventory, snapshots } = setup();
	await store.save("toapis", "fixture-key", now, false, 0);
	await inventory.check("image");
	const recorded = await snapshots.current(origin, "image");
	now += inventoryFreshMs;
	reply = unreachable;
	expect(await inventory.review(seedream, "image")).toMatchObject({
		access: { state: "stale" },
		skipped: true,
	});
	expect(await snapshots.current(origin, "image")).toEqual(recorded);
});

test("a stale Review with no free check stays stale", async () => {
	const { store, inventory } = setup();
	await store.save("toapis", "fixture-key", now, false, 0);
	for (let attempt = 0; attempt < 3; attempt++) await inventory.check("image");
	now += inventoryFreshMs;
	expect(await inventory.review(seedream, "image")).toMatchObject({
		access: { state: "stale" },
		skipped: false,
	});
	expect(calls).toHaveLength(3);
});

test("a video check leaves the credential and the image snapshot byte-identical", async () => {
	const { store, inventory } = setup();
	await store.save("toapis", "fixture-key", now, true, 0);
	await inventory.check("image");
	const before = await db.use((conn) =>
		Promise.all([
			conn.get(sql`SELECT * FROM provider_credential WHERE provider='toapis'`),
			conn.get(sql`SELECT * FROM provider_inventory WHERE scope='image'`),
		]),
	);
	for (const response of [list(), new Response(null, { status: 500 }), list("seedance-2-5")]) {
		reply = async () => response;
		await inventory.check("video");
		expect(await store.credential("toapis", 1, "toapis-video")).toEqual({
			key: "fixture-key",
			revision: 1,
		});
	}
	expect(
		await db.use((conn) =>
			Promise.all([
				conn.get(sql`SELECT * FROM provider_credential WHERE provider='toapis'`),
				conn.get(sql`SELECT * FROM provider_inventory WHERE scope='image'`),
			]),
		),
	).toEqual(before);
});

test("until the video claim reads the snapshot, a video check also keeps the Seedance record", async () => {
	const { store, inventory } = setup();
	await store.save("toapis", "fixture-key", now, false, 0);
	const record = () =>
		db.use((conn) => conn.get<{ state: string }>(sql`SELECT state FROM model_access`));
	for (const [response, state] of [
		[list(), "missing"],
		[new Response(null, { status: 500 }), "unverified"],
		[list("seedance-2-5"), "eligible"],
	] as const) {
		reply = async () => response;
		await inventory.check("video");
		expect((await record())?.state).toBe(state);
	}
});

test("Connect records the image snapshot it read, then Check again replaces it", async () => {
	const { store, inventory, snapshots } = setup();
	expect(
		await store.save("toapis", "fixture-key", now, true, 0, false, ["doubao-seedream-5-5"]),
	).toBe(true);
	expect(await snapshots.current(origin, "image")).toEqual({
		revision: 1,
		checkedAt: now,
		outcome: "succeeded",
		models: ["doubao-seedream-5-5"],
	});
	reply = async () => list("fixture-other");
	now += 1000;
	expect(await inventory.check("image")).toMatchObject({ outcome: "recorded" });
	expect(await snapshots.current(origin, "image")).toMatchObject({
		checkedAt: now,
		models: ["fixture-other"],
	});
	// A Poyo.ai save records no ToAPIs snapshot.
	await store.save("poyo", "fixture-poyo", now, false, 0, false, ["ignored"]);
	expect(await db.use((conn) => conn.all(sql`SELECT * FROM provider_inventory`))).toHaveLength(1);
});
