import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { sql } from "drizzle-orm";
import { createOwnerDirectory } from "../../../../tests/fixtures/owner-directory";
import {
	type AccessInputs,
	type AccessState,
	accessQueues,
	type InventoryKey,
	type InventoryScope,
	inventoryFreshMs,
	resolveAccess,
} from "../../shared/providers/inventory";
import { type Installation, openInstallation } from "./installation";
import { inventoryAccess, inventoryListedSql } from "./inventory-store";

const origin = "https://toapis.com";
const now = 1_000_000_000_000;
const seedream: InventoryKey = {
	provider: "toapis",
	model: "doubao-seedream-5-5",
	route: "POST /v1/images/generations",
	operation: "text-to-image",
};
const seedance: InventoryKey = {
	provider: "toapis",
	model: "seedance-2-5",
	route: "POST /v1/videos/generations",
	operation: "first-frame-to-video",
};
// A derived row on the shipped model: another operation is not a shipped operation.
const derivedSeedream = { ...seedream, operation: "sequential-image-set" };
const derived = { ...seedream, model: "fixture-derived-image" };
const derivedVideo = { ...seedance, model: "fixture-derived-video", operation: "text-to-video" };

type Case = {
	name: string;
	key: InventoryKey;
	scope: InventoryScope;
	inputs: Partial<AccessInputs>;
	state: AccessState;
};
const snapshot = (
	models: string[] | null,
	checkedAt = now - 1000,
	outcome: "succeeded" | "rejected" | "unavailable" = "succeeded",
	revision = 1,
) => ({ revision, checkedAt, outcome, models });
const eligible = { revision: 1, state: "eligible" };

// One case table for the resolution rule and its SQL twin.
const cases: Case[] = [
	{
		name: "fresh listed",
		key: seedream,
		scope: "image",
		inputs: { snapshot: snapshot(["doubao-seedream-5-5"]) },
		state: "listed",
	},
	{
		name: "fresh listed derived row",
		key: derived,
		scope: "image",
		inputs: { snapshot: snapshot(["fixture-derived-image"]) },
		state: "listed",
	},
	{
		name: "fresh absent",
		key: seedream,
		scope: "image",
		inputs: { snapshot: snapshot([]), seedream: true },
		state: "absent",
	},
	{
		name: "failed: key refused",
		key: seedream,
		scope: "image",
		inputs: { snapshot: snapshot(null, now - 1000, "rejected"), seedream: true },
		state: "failed",
	},
	{
		name: "failed: unavailable",
		key: seedance,
		scope: "video",
		inputs: { snapshot: snapshot(null, now - 1000, "unavailable"), modelAccess: eligible },
		state: "failed",
	},
	{
		name: "exactly 24 h old",
		key: seedream,
		scope: "image",
		inputs: { snapshot: snapshot(["doubao-seedream-5-5"], now - inventoryFreshMs), seedream: true },
		state: "stale",
	},
	{
		name: "just under 24 h old",
		key: seedream,
		scope: "image",
		inputs: { snapshot: snapshot(["doubao-seedream-5-5"], now - inventoryFreshMs + 1) },
		state: "listed",
	},
	{
		name: "checked in the future",
		key: seedream,
		scope: "image",
		inputs: { snapshot: snapshot(["doubao-seedream-5-5"], now + 1), seedream: true },
		state: "stale",
	},
	{
		name: "another revision's snapshot",
		key: derived,
		scope: "image",
		inputs: { snapshot: snapshot(["fixture-derived-image"], now - 1000, "succeeded", 0) },
		state: "unchecked",
	},
	{
		name: "no readable key",
		key: seedream,
		scope: "image",
		inputs: { revision: null, snapshot: snapshot(["doubao-seedream-5-5"]), seedream: true },
		state: "disconnected",
	},
	{
		name: "image exception",
		key: seedream,
		scope: "image",
		inputs: { seedream: true },
		state: "exception",
	},
	{
		name: "image exception, edit",
		key: { ...seedream, operation: "reference-image-edit" },
		scope: "image",
		inputs: { seedream: true },
		state: "exception",
	},
	{
		name: "image exception beside another revision's snapshot",
		key: seedream,
		scope: "image",
		inputs: { seedream: true, snapshot: snapshot([], now - 1000, "succeeded", 0) },
		state: "exception",
	},
	{
		name: "video exception",
		key: seedance,
		scope: "video",
		inputs: { modelAccess: eligible },
		state: "exception",
	},
	{
		name: "no exception: key outside the list",
		key: derived,
		scope: "image",
		inputs: { seedream: true },
		state: "unchecked",
	},
	{
		name: "no exception: derived key on the shipped model",
		key: derivedSeedream,
		scope: "image",
		inputs: { seedream: true },
		state: "unchecked",
	},
	{
		name: "no exception: derived video key",
		key: derivedVideo,
		scope: "video",
		inputs: { modelAccess: eligible },
		state: "unchecked",
	},
	{
		name: "no exception: Seedream flag unset",
		key: seedream,
		scope: "image",
		inputs: { seedream: false },
		state: "unchecked",
	},
	{
		name: "no exception: model_access missing",
		key: seedance,
		scope: "video",
		inputs: {},
		state: "unchecked",
	},
	{
		name: "no exception: model_access missing state",
		key: seedance,
		scope: "video",
		inputs: { modelAccess: { revision: 1, state: "missing" } },
		state: "unchecked",
	},
	{
		name: "no exception: model_access unverified",
		key: seedance,
		scope: "video",
		inputs: { modelAccess: { revision: 1, state: "unverified" } },
		state: "unchecked",
	},
	{
		name: "no exception: model_access at another revision",
		key: seedance,
		scope: "video",
		inputs: { modelAccess: { revision: 0, state: "eligible" } },
		state: "unchecked",
	},
	{
		name: "no revival after a failed snapshot",
		key: seedream,
		scope: "image",
		inputs: { seedream: true, snapshot: snapshot(null, now - 1000, "unavailable") },
		state: "failed",
	},
	{
		name: "no revival after a stale snapshot",
		key: seedance,
		scope: "video",
		inputs: {
			modelAccess: eligible,
			snapshot: snapshot(["seedance-2-5"], now - 2 * inventoryFreshMs),
		},
		state: "stale",
	},
	{
		name: "no revival after an absent snapshot",
		key: seedance,
		scope: "video",
		inputs: { modelAccess: eligible, snapshot: snapshot([]) },
		state: "absent",
	},
];

const inputsOf = (partial: Partial<AccessInputs>): AccessInputs => ({
	revision: 1,
	snapshot: null,
	seedream: false,
	modelAccess: null,
	...partial,
});

test.each(cases.map((c) => [c.name, c] as const))("%s resolves as its case says", (_, c) => {
	expect(resolveAccess(c.key, c.scope, inputsOf(c.inputs), now).state).toBe(c.state);
});

test("a video-only snapshot leaves the image exception intact", () => {
	// Image resolution reads only the image snapshot, which the caller selects by scope.
	expect(resolveAccess(seedream, "image", inputsOf({ seedream: true }), now).state).toBe(
		"exception",
	);
});

describe("the SQL twin", () => {
	let directory: string;
	let db: Installation;
	beforeAll(async () => {
		directory = await createOwnerDirectory();
		db = await openInstallation(directory);
	});
	afterAll(async () => {
		await db.close();
		await rm(directory, { recursive: true, force: true });
	});
	beforeEach(async () => {
		await db.use(async (conn) => {
			await conn.run(sql`DELETE FROM provider_inventory`);
			await conn.run(sql`DELETE FROM model_access`);
		});
	});
	async function seed(
		{ revision, snapshot, seedream, modelAccess }: AccessInputs,
		scope: InventoryScope,
	) {
		await db.use(async (conn) => {
			await conn.run(
				revision === null
					? sql`UPDATE provider_credential SET revision=1, ciphertext=NULL, verified_at=NULL, seedream=NULL WHERE provider='toapis'`
					: sql`UPDATE provider_credential SET revision=${revision}, ciphertext='sealed', verified_at=1,
						seedream=${Number(seedream)} WHERE provider='toapis'`,
			);
			if (snapshot)
				await conn.run(sql`INSERT INTO provider_inventory VALUES ('toapis',${origin},${scope},${snapshot.revision},1,
					${snapshot.checkedAt},${snapshot.outcome},${snapshot.models && JSON.stringify(snapshot.models)})`);
			// A snapshot of the other scope never changes this one.
			await conn.run(sql`INSERT INTO provider_inventory VALUES ('toapis',${origin},${scope === "image" ? "video" : "image"},
				${revision ?? 1},1,${now},'succeeded','[]')`);
			if (modelAccess)
				await conn.run(sql`INSERT INTO model_access VALUES ('toapis','seedance-2-5',${modelAccess.revision},
					${modelAccess.state},1)`);
		});
	}

	test.each(cases.map((c) => [c.name, c] as const))("%s agrees with resolution", async (_, c) => {
		const inputs = inputsOf(c.inputs);
		await seed(inputs, c.scope);
		const row = await db.use((conn) =>
			conn.get<{
				queues: number;
			}>(sql`SELECT ${inventoryListedSql({ origin, scope: c.scope, key: c.key }, now)} AS queues
				FROM provider_credential c WHERE c.provider='toapis'`),
		);
		const expected = resolveAccess(c.key, c.scope, inputs, now);
		expect(Boolean(row?.queues)).toBe(accessQueues(expected));
		const read = await db.use((conn) =>
			inventoryAccess(conn, { origin, scope: c.scope, key: c.key, readable: inputs.revision }, now),
		);
		expect(read).toEqual(expected);
	});
});
