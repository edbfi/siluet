/**
 * Fail when a change rewrites or drops a migration the base commit had released.
 *
 *   bun scripts/db/released-append-only.ts <base commit SHA>
 *
 * The base's files are read as text with `git show` and parsed strictly. Fetched code
 * is never imported.
 */
import { createHash } from "node:crypto";
import { installationMigrations } from "../../src/lib/server/db/migrations";

const releasedPath = "src/lib/server/db/released-migrations.ts";
const migrationsPath = "src/lib/server/db/migrations.ts";
const key = /^\d{14}_[a-z0-9_]+$/;
const digestPattern = /^[0-9a-f]{64}$/;

/**
 * Parse the `released` record of a `released-migrations.ts`: two-element arrays,
 * digest then name, one value per line, as Biome formats them.
 */
export function parseReleased(text: string): Map<string, string> {
	const lines = text.split("\n");
	const start = lines.indexOf("const released = [");
	if (start < 0) throw new Error("The released record is missing.");
	const entries = new Map<string, string>();
	let line = start + 1;
	const next = () => lines[line++] ?? "";
	for (;;) {
		const open = next();
		if (open === "] as const;") break;
		const digest = /^\t\t"([^"]*)",$/.exec(next())?.[1];
		const name = /^\t\t"([^"]*)",$/.exec(next())?.[1];
		const close = next();
		if (
			open !== "\t[" ||
			close !== "\t]," ||
			!digest ||
			!digestPattern.test(digest) ||
			!name ||
			!key.test(name) ||
			entries.has(name)
		)
			throw new Error(`Unexpected line in the released record near line ${line}.`);
		entries.set(name, digest);
	}
	if (!entries.size) throw new Error("The released record has no entries.");
	return entries;
}

/** Every migration name quoted as a record key in a `migrations.ts`. */
export function quotedMigrationKeys(text: string) {
	return new Set([...text.matchAll(/^\t"(\d{14}_[a-z0-9_]+)":/gm)].map((match) => match[1]));
}

export const sqlDigest = (value: string) => createHash("sha256").update(value).digest("hex");

/** Problems that make the head rewrite or drop something the base released. */
export function appendOnlyProblems(
	baseReleased: ReadonlyMap<string, string>,
	baseMigrationKeys: ReadonlySet<string>,
	head: Readonly<Record<string, string>>,
) {
	const problems: string[] = [];
	for (const [name, digest] of baseReleased) {
		const sql = head[name];
		if (sql === undefined) problems.push(`${name} was released and is missing.`);
		else if (sqlDigest(sql) !== digest) problems.push(`${name} changed after its release.`);
	}
	for (const name of baseMigrationKeys)
		if (!baseReleased.has(name))
			problems.push(`${name} is in the base migrations but not released.`);
	return problems;
}

async function show(base: string, path: string) {
	const child = Bun.spawn(["git", "show", `${base}:${path}`], { stdout: "pipe", stderr: "pipe" });
	const [text, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
	if (code !== 0) throw new Error(`git show ${base}:${path} failed.`);
	return text;
}

export async function main(argv: readonly string[]) {
	const [base] = argv;
	if (argv.length !== 1 || !base || !/^[0-9a-f]{40}$/.test(base))
		throw new Error("Pass the base commit's full SHA.");
	const problems = appendOnlyProblems(
		parseReleased(await show(base, releasedPath)),
		quotedMigrationKeys(await show(base, migrationsPath)),
		installationMigrations,
	);
	if (problems.length) throw new Error(problems.join("\n"));
}

if (import.meta.main) {
	await main(Bun.argv.slice(2)).catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : "Migration guard failed.");
		process.exit(1);
	});
	console.info("Released migrations are unchanged.");
}
