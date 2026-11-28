import { afterEach, beforeEach, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { createOwnerDirectory } from "../../../../../tests/fixtures/owner-directory";
import { inventoryFreshMs, listingCaveat } from "../../../shared/providers/inventory";
import { type Installation, openInstallation } from "../../db/installation";
import { providerStore } from "../../db/provider-store";
import { createInventory } from "./inventory";
import { inventorySection } from "./inventory-settings";

let directory: string;
let db: Installation;
let now: number;
let reply: () => Promise<Response>;
const list = (...ids: string[]) =>
	Response.json({ success: true, object: "list", data: ids.map((id) => ({ id })) });

beforeEach(async () => {
	directory = await createOwnerDirectory();
	db = await openInstallation(directory);
	now = Date.UTC(2026, 10, 28, 9, 30);
	reply = async () => list("doubao-seedream-5-5", "seedance-2-5", "midjourney");
});
afterEach(async () => {
	await db.close();
	await rm(directory, { recursive: true, force: true });
});
const setup = async (seedream = false) => {
	const store = providerStore(db);
	await store.save("toapis", "fixture-key", now, seedream, 0);
	return createInventory(db, store, { read: () => reply(), now: () => now });
};

test("each section lists every ToAPIs ledger ID of its media, shipped first", async () => {
	const inventory = await setup();
	await inventory.check("image");
	await inventory.check("video");
	const image = await inventorySection(inventory, "image");
	const video = await inventorySection(inventory, "video");
	expect(image.models).toHaveLength(58);
	expect(video.models).toHaveLength(64);
	expect(image.models[0]).toEqual({ id: "doubao-seedream-5-5", status: "listed" });
	expect(video.models[0]).toEqual({ id: "seedance-2-5", status: "listed" });
	// Midjourney and the official Grok Imagine video rows appear in both.
	for (const section of [image, video])
		expect(section.models.find(({ id }) => id === "midjourney")?.status).toBe("listed");
	expect(image.models.find(({ id }) => id === "grok-imagine-video-official")?.status).toBe(
		"absent",
	);
	const rest = image.models.slice(1).map(({ id }) => id);
	expect(rest).toEqual([...rest].sort());
	expect(image.caveat).toBe(listingCaveat);
});

test.each([
	[
		"listed",
		async () => list("doubao-seedream-5-5"),
		0,
		"ToAPIs listed doubao-seedream-5-5 for this key at 2026-11-28 09:30:00 UTC.",
		"listed",
	],
	[
		"absent",
		async () => list(),
		0,
		"ToAPIs did not list doubao-seedream-5-5 for this key at 2026-11-28 09:30:00 UTC.",
		"absent",
	],
	[
		"failed",
		async () => new Response(null, { status: 401 }),
		0,
		"The ToAPIs model check failed at 2026-11-28 09:30:00 UTC (key refused). Check again.",
		"unknown",
	],
	[
		"stale",
		async () => list("doubao-seedream-5-5"),
		inventoryFreshMs,
		"The ToAPIs model list is more than 24 hours old. Check again.",
		"unknown",
	],
] as const)(
	"a %s snapshot shows its line and marks each ID",
	async (_, response, age, line, status) => {
		const inventory = await setup();
		reply = response;
		await inventory.check("image");
		now += age;
		const section = await inventorySection(inventory, "image");
		expect(section.line).toBe(line);
		expect(section.models[0].status).toBe(status);
		expect(section.models.every((model) => model.status === "unknown")).toBe(status === "unknown");
	},
);

test("before any check, a section asks for one, and the shipped exception keeps its text", async () => {
	const inventory = await setup(true);
	const image = await inventorySection(inventory, "image");
	expect(image.line).toBe("The global image model list included this model for this key.");
	expect(image.models.every(({ status }) => status === "unknown")).toBe(true);
	expect((await inventorySection(inventory, "video")).line).toBe("Check ToAPIs model access.");
});
