import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { installationMigrations } from "../../src/lib/server/db/migrations";
import { releasedMigrations } from "../../src/lib/server/db/released-migrations";
import {
	appendOnlyProblems,
	main,
	parseReleased,
	quotedMigrationKeys,
	sqlDigest,
} from "./released-append-only";

const released = await readFile("src/lib/server/db/released-migrations.ts", "utf8");
const migrationsSource = await readFile("src/lib/server/db/migrations.ts", "utf8");
const first = "20261121000000_owner_access";
const record = (...entries: [string, string][]) =>
	[
		"const released = [",
		...entries.flatMap(([digest, name]) => ["\t[", `\t\t"${digest}",`, `\t\t"${name}",`, "\t],"]),
		"] as const;",
	].join("\n");

test("the committed record parses to the map the app imports", () => {
	expect(parseReleased(released)).toEqual(new Map(releasedMigrations));
	expect([...quotedMigrationKeys(migrationsSource)].sort()).toEqual(
		Object.keys(installationMigrations).sort(),
	);
});

test("an untouched release passes", () => {
	expect(
		appendOnlyProblems(
			releasedMigrations,
			new Set(releasedMigrations.keys()),
			installationMigrations,
			releasedMigrations,
		),
	).toEqual([]);
});

test("a new migration that sorts before a released one fails", () => {
	const head = { ...installationMigrations, "20261121100000_backdated": "SELECT 1;" };
	expect(
		appendOnlyProblems(
			releasedMigrations,
			new Set(releasedMigrations.keys()),
			head,
			releasedMigrations,
		),
	).toEqual([
		"20261121100000_backdated sorts before the released 20261125120000_video_profile_rearm.",
	]);
	const later = { ...installationMigrations, "20991231000000_later": "SELECT 1;" };
	expect(
		appendOnlyProblems(
			releasedMigrations,
			new Set(releasedMigrations.keys()),
			later,
			releasedMigrations,
		),
	).toEqual([]);
});

test("a released entry removed or changed in the head's record fails", () => {
	const keys = new Set(releasedMigrations.keys());
	const removed = new Map(releasedMigrations);
	removed.delete(first);
	expect(appendOnlyProblems(releasedMigrations, keys, installationMigrations, removed)).toEqual([
		`${first} is missing from the released record.`,
	]);
	const changed = new Map(releasedMigrations).set(first, "0".repeat(64));
	expect(appendOnlyProblems(releasedMigrations, keys, installationMigrations, changed)).toEqual([
		`${first} changed in the released record.`,
	]);
});

test("edited SQL, a removed key or a rewritten hash fails", () => {
	const keys = new Set(releasedMigrations.keys());
	const edited = { ...installationMigrations, [first]: `${installationMigrations[first]} ` };
	expect(appendOnlyProblems(releasedMigrations, keys, edited, releasedMigrations)).toEqual([
		`${first} changed after its release.`,
	]);
	const { [first]: _, ...removed } = installationMigrations;
	expect(appendOnlyProblems(releasedMigrations, keys, removed, releasedMigrations)).toEqual([
		`${first} was released and is missing.`,
	]);
	const rewritten = new Map(releasedMigrations).set(first, "0".repeat(64));
	expect(appendOnlyProblems(rewritten, keys, installationMigrations, rewritten)).toEqual([
		`${first} changed after its release.`,
	]);
});

test("a base migration absent from the base's released map fails", () => {
	const base = new Map(releasedMigrations);
	base.delete("20261123120000_automatic_save");
	expect(
		appendOnlyProblems(
			base,
			new Set(releasedMigrations.keys()),
			installationMigrations,
			releasedMigrations,
		),
	).toEqual(["20261123120000_automatic_save is in the base migrations but not released."]);
});

test("the record parser refuses anything but its exact shape", () => {
	const digest = sqlDigest("x");
	expect(parseReleased(record([digest, first]))).toEqual(new Map([[first, digest]]));
	for (const text of [
		record(),
		record([digest, first], [digest, first]),
		record([digest.toUpperCase(), first]),
		record([first, digest]),
		record([digest, "owner_access"]),
		record([digest, first]).replace("\t],", "\t],\n\t// extra"),
		record([digest, first]).replace('\t\t"', '\t\t "'),
		record([digest, first]).replace("] as const;", ""),
		"const other = [];",
	])
		expect(() => parseReleased(text)).toThrow();
});

test("the command refuses an empty or non-SHA base", async () => {
	for (const argv of [[], [""], ["main"], ["abc12"], ["HEAD~1"], ["a".repeat(40), "extra"]])
		await expect(main(argv)).rejects.toThrow("Pass the base commit SHA.");
	const child = Bun.spawn(["bun", "scripts/db/released-append-only.ts", ""], {
		stdout: "ignore",
		stderr: "ignore",
	});
	expect(await child.exited).toBe(1);
});

test("the checked-out commit passes against itself", async () => {
	const head = Bun.spawnSync(["git", "rev-parse", "HEAD"]).stdout.toString().trim();
	await expect(main([head])).resolves.toBeUndefined();
});
