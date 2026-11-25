import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { connect } from "@tursodatabase/database";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/tursodatabase/database";
import { migrations37 } from "../../../../tests/fixtures/db/migrations-37";
import { migrationsAs2 } from "../../../../tests/fixtures/db/migrations-as2";
import { installationMigrations, migrateInstallation } from "./migrations";
import { releasedMigrations } from "./released-migrations";

test("a recognized migration prefix is upgraded on reopen", async () => {
	const client = await connect(":memory:");
	try {
		const db = drizzle({ client });
		const first = { "20261121000000_first": "CREATE TABLE sample (id INTEGER)" };
		await migrateInstallation(db, true, first);
		await migrateInstallation(db, false, {
			...first,
			"20261122000000_second": "ALTER TABLE sample ADD COLUMN label TEXT",
		});
		await db.run(sql`INSERT INTO sample (label) VALUES ('stored')`);
		expect(await db.get(sql`SELECT label FROM sample`)).toEqual({ label: "stored" });
	} finally {
		await client.close();
	}
});

test("a failed initial migration rolls back its schema and history", async () => {
	const client = await connect(":memory:");
	try {
		const db = drizzle({ client });
		await expect(
			migrateInstallation(db, true, {
				"20261121000000_first":
					"CREATE TABLE sample (id INTEGER) --> statement-breakpoint INSERT INTO missing_fixture VALUES (1)",
			}),
		).rejects.toThrow();
		expect(await db.all(sql`SELECT name FROM sqlite_master WHERE name='sample'`)).toEqual([]);
		expect(await db.all(sql`SELECT name FROM __drizzle_migrations`)).toEqual([]);
	} finally {
		await client.close();
	}
});

test("upgrading saved jobs preserves Gallery entries and accepts bounded operation identifiers", async () => {
	const client = await connect(":memory:");
	try {
		const db = drizzle({ client });
		const previous = Object.fromEntries(
			Object.entries(installationMigrations).filter(
				([name]) => name <= "20261121223139_first_saved_image",
			),
		);
		await migrateInstallation(db, true, previous);
		await db.run(sql`INSERT INTO image_job (id, binding, provider, revision, quote, state, model,
			created_at, poll_deadline, submission_recorded_at, task_id)
			VALUES ('failed-job', 'first-binding', 'toapis', 3, '{}', 'failed', 'doubao-seedream-5-5', 5, 120010, 10, 'task-first'),
			('saved-job', 'second-binding', 'poyo', 7, '{}', 'completed', 'seedream-5.5', 5, 120020, 20, 'task-second')`);
		await db.run(
			sql`INSERT INTO gallery_image VALUES ('saved-job', 'saved', 'image/png', 1, 1, 68, 'digest', 30)`,
		);
		await migrateInstallation(db, false, installationMigrations);
		const jobs = await db.all(
			sql`SELECT binding, state, revision, task_id, operation, gallery_reason, failure_reason FROM image_job ORDER BY id`,
		);
		expect(jobs).toEqual([
			{
				binding: "first-binding",
				state: "failed",
				revision: 3,
				task_id: "task-first",
				failure_reason: null,
				operation: null,
				gallery_reason: null,
			},
			{
				binding: "second-binding",
				state: "completed",
				revision: 7,
				task_id: "task-second",
				failure_reason: null,
				operation: null,
				gallery_reason: null,
			},
		]);
		expect(await db.get(sql`SELECT job_id, state FROM gallery_image`)).toEqual({
			job_id: "saved-job",
			state: "saved",
		});
		// A later adapter can store its registered operation without a second column migration.
		for (const operation of [
			"text-to-image",
			"image-layer-decomposition",
			"v2-edit",
			"a".repeat(64),
		]) {
			await db.run(sql`UPDATE image_job SET operation=${operation} WHERE id='saved-job'`);
			expect(await db.get(sql`SELECT operation FROM image_job WHERE id='saved-job'`)).toEqual({
				operation,
			});
		}
		for (const operation of [
			"",
			"a".repeat(65),
			"Text-to-image",
			"a_b",
			"a/b",
			"-edit",
			"edit-",
			"a--b",
			"a\0b",
			"é",
		]) {
			await expect(
				db.run(sql`UPDATE image_job SET operation=${operation} WHERE id='saved-job'`).execute(),
			).rejects.toThrow();
		}
		await expect(
			db
				.run(sql`UPDATE image_job SET failure_reason='raw-provider-detail' WHERE id='failed-job'`)
				.execute(),
		).rejects.toThrow();
		await expect(
			db
				.run(
					sql`UPDATE image_job SET failure_reason='reference_media_unreadable' WHERE id='saved-job'`,
				)
				.execute(),
		).rejects.toThrow();
		await expect(
			db.run(sql`UPDATE image_job SET gallery_reason='raw-detail' WHERE id='saved-job'`).execute(),
		).rejects.toThrow();
		await expect(
			db
				.run(sql`UPDATE image_job SET gallery_reason='unsupported-image' WHERE id='failed-job'`)
				.execute(),
		).rejects.toThrow();
	} finally {
		await client.close();
	}
});

test("released migrations keep their SQL and new ones sort after the last release", () => {
	const digest = (value: string) => createHash("sha256").update(value).digest("hex");
	const migrations: Record<string, string> = installationMigrations;
	const released = [...releasedMigrations.keys()].sort();
	for (const name of released)
		expect(digest(migrations[name] ?? "")).toBe(releasedMigrations.get(name) ?? "");
	const last = released.at(-1) ?? "";
	for (const name of Object.keys(migrations))
		if (!releasedMigrations.has(name)) expect(name > last).toBe(true);
	// The pinned #37 and AS2 histories are the released prefix, byte for byte.
	for (const [name, value] of Object.entries({ ...migrations37, ...migrationsAs2 }))
		expect(digest(value)).toBe(releasedMigrations.get(name) ?? "");
});

test("the video profile re-arm sorts last", () => {
	expect(Object.keys(installationMigrations).sort().at(-1)).toBe(
		"20261125120000_video_profile_rearm",
	);
});
