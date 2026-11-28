import { afterEach, beforeEach, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { sql } from "drizzle-orm";
import { createOwnerDirectory } from "../../../../tests/fixtures/owner-directory";
import { type Installation, openInstallation } from "./installation";
import { type InventoryWrite, inventoryStore } from "./inventory-store";
import { providerStore } from "./provider-store";

const origin = "https://toapis.com";
let db: Installation;
let dir: string;
let store: ReturnType<typeof inventoryStore>;

beforeEach(async () => {
	dir = await createOwnerDirectory();
	db = await openInstallation(dir);
	store = inventoryStore(db);
	await providerStore(db).save("toapis", "fixture-toapis", 1, false, 0);
});
afterEach(async () => {
	await db.close();
	await rm(dir, { recursive: true, force: true });
});

const write = (
	generation: number,
	result: InventoryWrite["result"],
	revision = 1,
	checkedAt = 10,
) => store.record({ origin, scope: "image", revision, generation, checkedAt, result });
const listed = (...models: string[]) => ({ outcome: "succeeded", models }) as const;
const rows = () =>
	db.use((conn) => conn.all(sql`SELECT * FROM provider_inventory ORDER BY scope, revision`));

test("generations rise per origin and scope", async () => {
	expect(await store.issue(origin, "image")).toBe(1);
	expect(await store.issue(origin, "image")).toBe(2);
	expect(await store.issue(origin, "video")).toBe(1);
	expect(await store.issue("https://fixture.example", "image")).toBe(1);
});

test("a second success replaces the whole set, and a failure keeps no IDs", async () => {
	expect(await write(1, listed("a", "b"))).toBe(true);
	expect(await write(2, listed("c"), 1, 20)).toBe(true);
	expect(await store.current(origin, "image")).toEqual({
		revision: 1,
		checkedAt: 20,
		outcome: "succeeded",
		models: ["c"],
	});
	expect(await write(3, { outcome: "rejected" }, 1, 30)).toBe(true);
	expect(await store.current(origin, "image")).toEqual({
		revision: 1,
		checkedAt: 30,
		outcome: "rejected",
		models: null,
	});
	expect(await rows()).toHaveLength(1);
});

test("a late response from an older generation writes nothing, in both completion orders", async () => {
	const [first, second] = [await store.issue(origin, "image"), await store.issue(origin, "image")];
	expect(await write(second, listed("new"), 1, 20)).toBe(true);
	expect(await write(first, listed("old"))).toBe(false);
	expect((await store.current(origin, "image"))?.models).toEqual(["new"]);

	const [third, fourth] = [await store.issue(origin, "image"), await store.issue(origin, "image")];
	expect(await write(third, listed("third"), 1, 30)).toBe(true);
	expect(await write(fourth, listed("fourth"), 1, 40)).toBe(true);
	expect((await store.current(origin, "image"))?.models).toEqual(["fourth"]);
});

test("a key replaced mid-check writes nothing, and the late old-revision answer leaves the new snapshot", async () => {
	const stale = await store.issue(origin, "image");
	expect(await providerStore(db).save("toapis", "fixture-replaced", 2, false, 1)).toBe(true);
	expect(await write(stale, listed("old"))).toBe(false);
	expect(await store.current(origin, "image")).toBeNull();

	const fresh = await store.issue(origin, "image");
	expect(await write(fresh, listed("new"), 2)).toBe(true);
	expect(await write(stale, listed("old"), 1)).toBe(false);
	expect(await store.current(origin, "image")).toMatchObject({ revision: 2, models: ["new"] });
});

test("a write for the current revision prunes older revisions; a refused write prunes nothing", async () => {
	await write(1, listed("one"));
	await db.use((conn) =>
		conn.run(sql`UPDATE provider_credential SET revision=2 WHERE provider='toapis'`),
	);
	await db.use((conn) =>
		conn.run(
			sql`INSERT INTO provider_inventory VALUES ('toapis',${origin},'image',2,5,10,'succeeded','["two"]')`,
		),
	);
	// Generation 4 is older than the stored 5, so RETURNING refuses it and nothing is pruned.
	expect(await write(4, listed("late"), 2)).toBe(false);
	expect(await rows()).toHaveLength(2);
	expect(await write(6, listed("three"), 2)).toBe(true);
	expect(await rows()).toEqual([
		expect.objectContaining({ revision: 2, generation: 6, models: '["three"]' }),
	]);
});

test("a removed key records nothing", async () => {
	await providerStore(db).remove("toapis");
	expect(await write(1, listed("a"), 2)).toBe(false);
	expect(await store.current(origin, "image")).toBeNull();
});

test("each scope keeps its own snapshot", async () => {
	await write(1, listed("image-only"));
	await store.record({
		origin,
		scope: "video",
		revision: 1,
		generation: 1,
		checkedAt: 11,
		result: { outcome: "unavailable" },
	});
	expect((await store.current(origin, "image"))?.models).toEqual(["image-only"]);
	expect((await store.current(origin, "video"))?.outcome).toBe("unavailable");
});

test("a concurrent reader sees the old set or the new set, never a mix", async () => {
	const old = Array.from({ length: 200 }, (_, index) => `old-${index}`).sort();
	const replacement = Array.from({ length: 200 }, (_, index) => `new-${index}`).sort();
	await write(1, listed(...old));
	const reads = Array.from({ length: 20 }, () => store.current(origin, "image"));
	const written = write(2, listed(...replacement), 1, 20);
	const seen = await Promise.all([...reads, store.current(origin, "image")]);
	expect(await written).toBe(true);
	for (const snapshot of seen)
		expect([JSON.stringify(old), JSON.stringify(replacement)]).toContain(
			JSON.stringify(snapshot?.models),
		);
	expect((await store.current(origin, "image"))?.models).toEqual(replacement);
});
