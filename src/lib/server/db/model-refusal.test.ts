import { afterEach, beforeEach, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { sql } from "drizzle-orm";
import { createOwnerDirectory } from "../../../../tests/fixtures/owner-directory";
import { imageJobPollingWindowMs } from "./image-job-schema";
import { type Installation, openInstallation } from "./installation";
import { modelRefusals, recordRefusal } from "./model-refusal";
import { providerStore } from "./provider-store";

let db: Installation;
let dir: string;

beforeEach(async () => {
	dir = await createOwnerDirectory();
	db = await openInstallation(dir);
	await providerStore(db).save("poyo", "fixture-poyo", 1, false, 0);
});
afterEach(async () => {
	await db.close();
	await rm(dir, { recursive: true, force: true });
});

const job = (id: string, revision: number, model = "flux-dev") =>
	db.use((conn) =>
		conn.run(sql`INSERT INTO image_job(id,binding,provider,revision,quote,state,created_at,model,poll_deadline)
			VALUES(${id},'b','poyo',${revision},'{}','rejected',5,${model},${5 + imageJobPollingWindowMs})`),
	);
const record = (id: string, now: number) =>
	db.use((conn) => conn.transaction((tx) => recordRefusal(tx, id, now), { behavior: "immediate" }));

test("a refusal is kept once per model for the job's current credential revision", async () => {
	await job("first", 1);
	await job("second", 1);
	await record("first", 10);
	await record("second", 20);
	expect(await modelRefusals(db).current("poyo")).toEqual([{ model: "flux-dev", refusedAt: 20 }]);
});

test("a refusal recorded against a superseded revision writes nothing", async () => {
	await job("old", 1);
	expect(await providerStore(db).save("poyo", "fixture-poyo", 2, false, 1)).toBe(true);
	await record("old", 10);
	expect(await db.use((conn) => conn.all(sql`SELECT * FROM model_refusal`))).toEqual([]);
});

test("reads return only the current revision, and a new revision clears older records", async () => {
	await job("refused", 1, "kling-o3-image");
	await record("refused", 10);
	await db.use((conn) =>
		conn.run(sql`INSERT INTO model_refusal(provider,model,credential_revision,refused_at,job_id)
			VALUES('poyo','flux-dev',7,11,'elsewhere')`),
	);
	expect(await modelRefusals(db).current("poyo")).toEqual([
		{ model: "kling-o3-image", refusedAt: 10 },
	]);
	expect(await providerStore(db).save("poyo", "fixture-poyo", 2, false, 1)).toBe(true);
	expect(await modelRefusals(db).current("poyo")).toEqual([]);
	expect(await db.use((conn) => conn.all(sql`SELECT * FROM model_refusal`))).toEqual([]);
	await providerStore(db).remove("poyo");
	expect(await modelRefusals(db).current("poyo")).toEqual([]);
});

test("removing a key clears its refusals in the same transaction, or changes nothing", async () => {
	await job("refused", 1);
	await record("refused", 10);
	// A refusal delete that fails must leave the key saved, never removed with its refusals kept.
	await db.use((conn) =>
		conn.run(sql`CREATE TRIGGER keep_refusals BEFORE DELETE ON model_refusal
			BEGIN SELECT RAISE(ABORT, 'refusals kept'); END`),
	);
	await expect(providerStore(db).remove("poyo")).rejects.toThrow();
	expect(
		await db.use((conn) =>
			conn.get(sql`SELECT revision, ciphertext IS NOT NULL AS saved FROM provider_credential
				WHERE provider='poyo'`),
		),
	).toEqual({ revision: 1, saved: 1 });
	expect(await modelRefusals(db).current("poyo")).toEqual([{ model: "flux-dev", refusedAt: 10 }]);
});
