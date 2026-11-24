import { afterEach, beforeEach, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { sql } from "drizzle-orm";
import { createOwnerDirectory } from "../../../../tests/fixtures/owner-directory";
import { type Installation, openInstallation } from "./installation";
import { mediaCleaning } from "./media-cleaning";

let directory: string;
let installation: Installation;

beforeEach(async () => {
	directory = await createOwnerDirectory();
	installation = await openInstallation(directory);
});
afterEach(async () => {
	await installation.close();
	await rm(directory, { recursive: true, force: true });
});

test("a fresh installation cleans attached files at revision 0", async () => {
	expect(await mediaCleaning(installation).read()).toEqual({ enabled: true, revision: 0 });
});

test("a change bumps the revision once; an unchanged save keeps it", async () => {
	const cleaning = mediaCleaning(installation);
	expect(await cleaning.set(true, 0)).toEqual({ saved: true, enabled: true, revision: 0 });
	expect(await cleaning.set(false, 0)).toEqual({ saved: true, enabled: false, revision: 1 });
	expect(await cleaning.set(false, 1)).toEqual({ saved: true, enabled: false, revision: 1 });
	expect(await cleaning.set(true, 1)).toEqual({ saved: true, enabled: true, revision: 2 });
	expect(await cleaning.read()).toEqual({ enabled: true, revision: 2 });
});

test("a stale revision changes nothing and returns the stored value", async () => {
	const cleaning = mediaCleaning(installation);
	await cleaning.set(false, 0);
	expect(await cleaning.set(true, 0)).toEqual({ saved: false, enabled: false, revision: 1 });
	// Even a stale request that matches the stored value reports the conflict.
	expect(await cleaning.set(false, 0)).toEqual({ saved: false, enabled: false, revision: 1 });
	expect(await cleaning.read()).toEqual({ enabled: false, revision: 1 });
});

test("an unreadable setting refuses instead of choosing a mode", async () => {
	await installation.use((db) => db.run(sql`DELETE FROM media_cleaning`));
	await expect(mediaCleaning(installation).read()).rejects.toThrow("Cleaning setting unavailable.");
	await expect(mediaCleaning(installation).set(false, 0)).rejects.toThrow(
		"Cleaning setting unavailable.",
	);
});

test("the schema refuses a second row or an invalid value", async () => {
	for (const statement of [
		sql`INSERT INTO media_cleaning VALUES (2, 1, 0)`,
		sql`UPDATE media_cleaning SET enabled=2`,
		sql`UPDATE media_cleaning SET revision=-1`,
	])
		await expect(installation.use((db) => db.run(statement).execute())).rejects.toThrow();
});
