import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import bundledV1 from "../../pricing/v1/feed.json";
import bundledV2 from "../../pricing/v2/poyo.json";
import { decodePricingFeed } from "../../src/lib/shared/pricing/feed.ts";
import { decodePoyoV2Feed } from "../../src/lib/shared/pricing/poyo-feed.ts";
import h3Fixture from "../../tests/fixtures/h3-rate.v2.json";
import { sizedPoyoV2Feed } from "../../tests/fixtures/poyo-v2-feed.ts";
import { refreshPricingFeed } from "./refresh.ts";

const v1Path = "pricing/v1/feed.json";
const v2Path = "pricing/v2/poyo.json";
const v1LicensePath = "pricing/v1/LICENSE.poyo";
const v2LicensePath = "pricing/v2/LICENSE.poyo";
const script = resolve(import.meta.dir, "publish.sh");
const license = resolve(import.meta.dir, "../../", v1LicensePath);
const ref = "refs/heads/pricing-data";
const day = 86_400;

// Confirmations must be current, so they are derived from the real clock.
const nowSeconds = Math.floor(Date.now() / 1000);
const iso = (seconds: number) => new Date(seconds * 1000).toISOString().replace(".000Z", "Z");
const secondsToday = nowSeconds % day;
// Two confirmations on the current UTC day.
const earlierToday = iso(nowSeconds - Math.min(60, secondsToday));
const now = iso(nowSeconds);
const yesterday = iso(nowSeconds - day);

const v2 = { ...bundledV2, confirmedAt: now };
const newRevision = "abcdef0123456789abcdef0123456789abcdef01";
const newSource = iso(Date.parse(bundledV2.sourceDate) / 1000 + 1);

let sandbox: string;
let remote: string;
let local: string;
let summary: string;

beforeEach(() => {
	sandbox = mkdtempSync(resolve(tmpdir(), "siluet-pricing-"));
	remote = resolve(sandbox, "remote");
	local = resolve(sandbox, "local");
	summary = resolve(sandbox, "summary.md");
	git(sandbox, "init", "--bare", remote);
	git(sandbox, "init", "--bare", local);
	git(local, "remote", "add", "origin", remote);
});

afterEach(() => {
	rmSync(sandbox, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]) {
	const result = Bun.spawnSync(["git", ...args], {
		cwd,
		env: { PATH: process.env.PATH, HOME: sandbox },
		stdout: "pipe",
		stderr: "pipe",
	});
	if (!result.success) throw new Error(result.stderr.toString());
	return result.stdout.toString();
}

/** Run the publisher with the feed as a file on stdin, as the workflow does. */
function publish(value: unknown, licensePath = license) {
	const input = resolve(sandbox, "input.json");
	writeFileSync(input, typeof value === "string" ? value : JSON.stringify(value));
	const result = Bun.spawnSync(
		["bash", "-c", 'bash "$0" poyo "$1" < "$2"', script, licensePath, input],
		{
			cwd: local,
			env: { PATH: process.env.PATH, HOME: sandbox, GITHUB_STEP_SUMMARY: summary },
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	return { ...result, out: result.stdout.toString(), err: result.stderr.toString() };
}

function head() {
	return git(remote, "rev-parse", ref).trim();
}

function blob(path: string, at = ref) {
	return git(remote, "rev-parse", `${at}:${path}`).trim();
}

function show(path: string, at = ref) {
	return git(remote, "show", `${at}:${path}`);
}

/** Write a data branch commit as an earlier publisher would have left it. */
function seed(files: Record<string, string>) {
	const index = resolve(sandbox, "seed-index");
	const env = { PATH: process.env.PATH, HOME: sandbox, GIT_INDEX_FILE: index };
	const run = (args: string[], stdin?: string) => {
		const result = Bun.spawnSync(["git", ...args], {
			cwd: remote,
			env,
			stdin: stdin === undefined ? undefined : new TextEncoder().encode(stdin),
			stdout: "pipe",
			stderr: "pipe",
		});
		if (!result.success) throw new Error(result.stderr.toString());
		return result.stdout.toString().trim();
	};
	rmSync(index, { force: true });
	for (const [path, content] of Object.entries(files)) {
		const id = run(["hash-object", "-w", "--stdin"], content);
		run(["update-index", "--add", "--cacheinfo", `100644,${id},${path}`]);
	}
	const tree = run(["write-tree"]);
	const parent = Bun.spawnSync(["git", "rev-parse", "--verify", "--quiet", ref], { cwd: remote });
	const parents = parent.success ? ["-p", parent.stdout.toString().trim()] : [];
	const commit = run(
		["-c", "user.name=seed", "-c", "user.email=seed@example.test", "commit-tree", tree, ...parents],
		"seed",
	);
	run(["update-ref", ref, commit]);
	return commit;
}

const licenseText = new TextDecoder("utf-8", { ignoreBOM: true }).decode(readFileSync(license));

function seedV2(feed: unknown, v1 = bundledV1) {
	return seed({
		[v1Path]: `${JSON.stringify(v1)}\n`,
		[v1LicensePath]: licenseText,
		[v2Path]: `${JSON.stringify(feed)}\n`,
		[v2LicensePath]: licenseText,
	});
}

test("bundles snapshots accepted by the shared feed decoders", () => {
	expect(JSON.stringify(decodePricingFeed(bundledV1))).toBe(JSON.stringify(bundledV1));
	expect(JSON.stringify(decodePoyoV2Feed(bundledV2))).toBe(JSON.stringify(bundledV2));
});

describe("PoYo v2 publication", () => {
	test("bootstraps both feeds with one license and reruns as a no-op", () => {
		const first = publish(v2);
		if (!first.success) throw new Error(first.err);
		expect(git(remote, "ls-tree", "-r", "--name-only", ref).split("\n").filter(Boolean)).toEqual([
			v1LicensePath,
			v1Path,
			v2LicensePath,
			v2Path,
		]);
		expect(show(v1LicensePath)).toBe(licenseText);
		expect(blob(v2LicensePath)).toBe(blob(v1LicensePath));
		expect(JSON.parse(show(v2Path))).toEqual(v2);
		expect(show(v2Path)).toEndWith("}\n");
		expect(JSON.parse(show(v1Path))).toEqual(bundledV1);
		expect(first.out).toContain("::notice title=Pricing published::PoYo pricing published");
		expect(readFileSync(summary, "utf8")).toContain(`confirmed ${now}`);
		const published = head();
		const rerun = publish(v2);
		expect(rerun.exitCode).toBe(0);
		expect(rerun.out).toContain("::notice title=Pricing not published::PoYo pricing is unchanged.");
		expect(head()).toBe(published);
	});

	test("bootstraps v2 on a legacy branch and keeps the v1 blob", () => {
		const legacy = seed({
			[v1Path]: `${JSON.stringify(bundledV1, null, "\t")}\n`,
			[v1LicensePath]: licenseText,
		});
		const v1Blob = blob(v1Path);
		const result = publish(v2);
		if (!result.success) throw new Error(result.err);
		expect(git(remote, "rev-parse", `${ref}^`).trim()).toBe(legacy);
		expect(blob(v1Path)).toBe(v1Blob);
		expect(JSON.parse(show(v2Path))).toEqual(v2);
	});

	test("a later day's confirmation keeps the v1 blob", () => {
		const seeded = seedV2({ ...v2, confirmedAt: yesterday });
		const v1Blob = blob(v1Path);
		const result = publish(v2);
		if (!result.success) throw new Error(result.err);
		expect(git(remote, "rev-parse", `${ref}^`).trim()).toBe(seeded);
		expect(blob(v1Path)).toBe(v1Blob);
		expect(JSON.parse(show(v2Path)).confirmedAt).toBe(now);
	});

	test("skips a second confirmation on the same UTC day with a notice", () => {
		expect(publish({ ...v2, confirmedAt: earlierToday }).success).toBe(true);
		const published = head();
		const result = publish(v2);
		expect(result.exitCode).toBe(0);
		expect(result.out).toContain(
			"::notice title=Pricing not published::PoYo pricing was already confirmed today.",
		);
		expect(readFileSync(summary, "utf8")).toContain("already confirmed today");
		expect(head()).toBe(published);
	});

	test("publishes a same-day revision or gap fill", () => {
		const gap = {
			...v2,
			confirmedAt: earlierToday,
			rates: { ...v2.rates, "z-image": { kind: "unavailable" } },
		};
		expect(publish(gap).success).toBe(true);
		const gapHead = head();
		const v1Blob = blob(v1Path);
		expect(publish(v2).success).toBe(true);
		expect(git(remote, "rev-parse", `${ref}^`).trim()).toBe(gapHead);
		expect(blob(v1Path)).not.toBe(v1Blob);
		expect(JSON.parse(show(v1Path))).toEqual(bundledV1);
		const revised = { ...v2, revision: newRevision, sourceDate: newSource };
		expect(publish(revised).success).toBe(true);
		expect(JSON.parse(show(v1Path))).toMatchObject({
			revision: newRevision,
			sourceDate: newSource,
		});
	});

	test("rejects ordering, timing and coverage violations without moving the branch", () => {
		expect(publish(v2).success).toBe(true);
		const published = head();
		const rejected: [unknown, RegExp][] = [
			[
				{ ...v2, revision: newRevision, sourceDate: newSource, confirmedAt: earlierToday },
				/older confirmation/,
			],
			[{ ...v2, revision: newRevision }, /newer source date/],
			[{ ...v2, confirmedAt: iso(nowSeconds + 120) }, /future/],
			[{ ...v2, confirmedAt: iso(nowSeconds - 2 * 3600) }, /one hour/],
			[{ ...v2, confirmedAt: bundledV2.sourceDate }, /expired|one hour/],
			[{ ...v2, rates: { ...v2.rates, "seedream-5.5": { kind: "unavailable" } } }, /changed/],
			[
				{ ...v2, rates: { "z-image": v2.rates["z-image"], extra: { kind: "unavailable" } } },
				/Invalid/,
			],
			[bundledV1, /Invalid/],
		];
		for (const [candidate, reason] of rejected) {
			const result = publish(candidate);
			expect(result.success).toBe(false);
			expect(result.err).toMatch(reason);
			expect(head()).toBe(published);
		}
		const reviewedLicense = resolve(sandbox, "reviewed-license");
		writeFileSync(reviewedLicense, "Synthetic revised upstream notice\n");
		expect(publish(v2, reviewedLicense).err).toMatch(/license/);
		expect(head()).toBe(published);
	});

	test("rejects a missing required model before projecting v1", () => {
		for (const model of ["z-image", "seedream-5.5"] as const) {
			const rates: Record<string, unknown> = { ...v2.rates };
			delete rates[model];
			const result = publish({ ...v2, rates });
			expect(result.err).toContain("Invalid PoYo v2 pricing feed handoff");
		}
		expect(git(remote, "for-each-ref")).toBe("");
	});

	test("keeps unfamiliar rates in v2 and projects them as unavailable in v1", () => {
		const unfamiliar = h3Fixture.rates["h3-max"];
		const candidate = {
			...h3Fixture,
			confirmedAt: now,
			rates: { ...h3Fixture.rates, "z-image": unfamiliar },
		};
		const result = publish(candidate);
		if (!result.success) throw new Error(result.err);
		expect(JSON.parse(show(v2Path))).toEqual(candidate);
		const v1 = JSON.parse(show(v1Path));
		expect(v1.rates).toEqual({
			"z-image": { kind: "unavailable" },
			"seedream-5.5": h3Fixture.rates["seedream-5.5"],
		});
		expect(decodePricingFeed(v1)).toEqual(v1);
		const changed = {
			...candidate,
			rates: { ...candidate.rates, "h3-max": { ...unfamiliar, resolutions: { "480p": "11" } } },
		};
		expect(publish(changed).err).toMatch(/changed/);
	});

	test("rejects a branch with unexpected contents", () => {
		seed({ [v1Path]: `${JSON.stringify(bundledV1)}\n`, [v1LicensePath]: licenseText, extra: "x" });
		expect(publish(v2).err).toContain("Unexpected contents");
	});

	test("publishes a 64 KiB feed that refresh reads, rereads it, and rejects one byte more", async () => {
		const largest = sizedPoyoV2Feed(65_536, { base: v2 });
		// Mirror pricing.yml: the collector prints indented JSON, the job output carries one
		// compact line, and the publish step writes it to a file for publish.sh.
		const workflow = resolve(import.meta.dir, "../../.github/workflows/pricing.yml");
		expect(readFileSync(workflow, "utf8")).toContain(`printf '%s' "$PRICING_FEED" > "$feed_file"`);
		const collected = resolve(sandbox, "collected.json");
		writeFileSync(collected, JSON.stringify(largest, null, "\t"));
		const output = Bun.spawnSync(
			[
				"bash",
				"-c",
				`jq -ces 'if length == 1 and (.[0] | type == "object") then .[0] else error("x") end' < "$0"`,
				collected,
			],
			{ stdout: "pipe" },
		);
		const line = output.stdout.toString().trimEnd();
		expect(line).not.toContain("\n");
		const result = publish(line);
		if (!result.success) throw new Error(result.err);
		const body = show(v2Path);
		expect(new TextEncoder().encode(body).byteLength).toBe(65_536);
		expect(publish(largest).out).toContain("PoYo pricing is unchanged.");
		const client = mkdtempSync(resolve(sandbox, "client-"));
		writeFileSync(resolve(client, "bundled-v2.json"), JSON.stringify(bundledV2));
		const refreshed = await refreshPricingFeed({
			bundledPath: resolve(client, "bundled-v1.json"),
			cachePath: resolve(client, "v1.json"),
			v2BundledPath: resolve(client, "bundled-v2.json"),
			v2CachePath: resolve(client, "v2.json"),
			fetchFeed: async () => new Response(body),
		});
		expect<unknown>(refreshed.feed).toEqual(largest);
		const published = head();
		const over = publish(sizedPoyoV2Feed(65_537, { base: v2 }));
		expect(over.err).toMatch(/size limit/);
		expect(head()).toBe(published);
	}, 30_000);

	test("rejects the published v1 decimal and rate drift", () => {
		for (const rate of [
			null,
			{ kind: "per-request", credits: 2 },
			{ kind: "per-request", credits: "0" },
			{ kind: "per-request", credits: "1234567890123" },
			{ kind: "per-request", credits: "0.0000001" },
		]) {
			expect(publish({ ...v2, rates: { ...v2.rates, "z-image": rate } }).success).toBe(false);
		}
		expect(publish({ ...v2, sourceDate: "2026-02-30T00:00:00Z" }).success).toBe(false);
		expect(git(remote, "for-each-ref")).toBe("");
	});
});

test("the TypeScript decoder and jq agree on v2 rate grammar", () => {
	const filter = resolve(import.meta.dir, "providers/poyo/publish-v2.jq");
	const nested = (depth: number): unknown => (depth === 0 ? "1" : { n: nested(depth - 1) });
	const cases: unknown[] = [
		{ kind: "per-second", a: nested(3) },
		{ kind: "per-second", a: nested(4) },
		{ kind: "per-second", a: "0" },
		{ kind: "per-second", a: "01" },
		{ kind: "per-second", a: "1.0000001" },
		{ kind: "per-second", a: 1 },
		{ kind: "per-second", a: ["1"] },
		{ kind: "per-second", a: null },
		{ kind: "Per-second", a: "1" },
		{ kind: "per-second", "bad key": "1" },
		{ kind: "unavailable", a: "1" },
		{ kind: "per-request", credits: "0" },
		{ kind: "per-request", credits: "1" },
	];
	for (const rate of cases) {
		for (const key of ["h3-max", "kling-2.1/pro", "_bad"]) {
			const feed = { ...v2, rates: { ...v2.rates, [key]: rate } };
			const output = Bun.spawnSync(["jq", "-RsceS", "-L", import.meta.dir, "-f", filter], {
				stdin: new TextEncoder().encode(JSON.stringify(feed)),
				stdout: "pipe",
				stderr: "pipe",
			});
			expect([key, rate, output.success]).toEqual([key, rate, Boolean(decodePoyoV2Feed(feed))]);
		}
	}
});
