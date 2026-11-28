import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import shippedV1 from "../../pricing/v1/feed.json";
import shippedV2 from "../../pricing/v2/poyo.json";
import { decodePricingFeed } from "../../src/lib/shared/pricing/feed.ts";
import { decodePoyoV2Feed } from "../../src/lib/shared/pricing/poyo-feed.ts";
import h3Fixture from "../../tests/fixtures/h3-rate.v2.json";
import pair from "../../tests/fixtures/poyo-basis-pair.json";
import {
	poyoV1Feed as bundledV1,
	poyoV2Feed as bundledV2,
	sizedPoyoV2Feed,
} from "../../tests/fixtures/poyo-v2-feed.ts";
import { canonicalJson } from "./local-feed.ts";
import { refreshPricingFeed } from "./refresh.ts";

const v1Path = "pricing/v1/feed.json";
const v2Path = "pricing/v2/poyo.json";
const v1LicensePath = "pricing/v1/LICENSE.poyo";
const v2LicensePath = "pricing/v2/LICENSE.poyo";
const basisPath = "pricing/v2/poyo-basis.json";
const script = resolve(import.meta.dir, "publish.sh");
const license = resolve(import.meta.dir, "../../", v1LicensePath);
const ref = "refs/heads/pricing-data";
const day = 86_400;

// Confirmations must be current, so they are derived from the real clock. The publication
// tests use a fixed v1 and v2 pair, so they do not move with the shipped bundles.
let nowSeconds = Math.floor(Date.now() / 1000);
if (nowSeconds % day === 0) {
	// At 00:00:00 UTC no earlier second exists on the same day.
	await Bun.sleep(1000);
	nowSeconds += 1;
}
const iso = (seconds: number) => new Date(seconds * 1000).toISOString().replace(".000Z", "Z");
// Two distinct confirmations on the current UTC day.
const earlierToday = iso(nowSeconds - Math.min(60, nowSeconds % day));
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

/**
 * The sandbox's git: without the background `maintenance` that each fetch and push would
 * otherwise start, which a run's throwaway repositories never need.
 */
const sandboxGitEnv = () => ({
	PATH: process.env.PATH,
	HOME: sandbox,
	GIT_CONFIG_COUNT: "1",
	GIT_CONFIG_KEY_0: "maintenance.auto",
	GIT_CONFIG_VALUE_0: "false",
});

function git(cwd: string, ...args: string[]) {
	const result = Bun.spawnSync(["git", ...args], {
		cwd,
		env: sandboxGitEnv(),
		stdout: "pipe",
		stderr: "pipe",
	});
	if (!result.success) throw new Error(result.stderr.toString());
	return result.stdout.toString();
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const digests = { "z-image": "0".repeat(64) };

/** The basis the collector pairs with a feed: its revision and canonical digest, no LF. */
function basisFor(feed: unknown, extra: Record<string, string> = digests) {
	const { revision } = feed as { revision?: unknown };
	return { revision, feedSha256: sha256(canonicalJson(feed)), digests: extra };
}

/**
 * Run the publisher with the handoff as a file on stdin, as the workflow does. A feed object is
 * handed off with the basis that pairs with it; a string is handed off as it is.
 */
function publish(value: unknown, licensePath = license, basis = basisFor(value)) {
	const input = resolve(sandbox, "input.json");
	writeFileSync(input, typeof value === "string" ? value : JSON.stringify({ feed: value, basis }));
	const result = Bun.spawnSync(["bash", script, "poyo", licensePath], {
		cwd: local,
		env: { ...sandboxGitEnv(), GITHUB_STEP_SUMMARY: summary },
		stdin: Bun.file(input),
		stdout: "pipe",
		stderr: "pipe",
	});
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
	const env = { ...sandboxGitEnv(), GIT_INDEX_FILE: index };
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
	expect(JSON.stringify(decodePricingFeed(shippedV1))).toBe(JSON.stringify(shippedV1));
	expect(JSON.stringify(decodePoyoV2Feed(shippedV2))).toBe(JSON.stringify(shippedV2));
});

describe("PoYo v2 publication", () => {
	test("bootstraps both feeds with one license and reruns as a no-op", () => {
		const first = publish(v2);
		if (!first.success) throw new Error(first.err);
		expect(git(remote, "ls-tree", "-r", "--name-only", ref).split("\n").filter(Boolean)).toEqual([
			v1LicensePath,
			v1Path,
			v2LicensePath,
			basisPath,
			v2Path,
		]);
		expect(show(basisPath)).toBe(`${canonicalJson(basisFor(v2))}\n`);
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

	test("publishes a same-day gap fill and projects v1 again", () => {
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
	});

	test("publishes a same-day revision", () => {
		// As the gap fill above leaves it: `v2` projects to the bundled v1.
		const seeded = seedV2(v2);
		const revised = { ...v2, revision: newRevision, sourceDate: newSource };
		expect(publish(revised).success).toBe(true);
		expect(git(remote, "rev-parse", `${ref}^`).trim()).toBe(seeded);
		expect(JSON.parse(show(v1Path))).toMatchObject({
			revision: newRevision,
			sourceDate: newSource,
		});
	});

	// One publisher run each: the branch is seeded as an earlier publish of `v2` left it.
	test.each<[string, unknown, RegExp]>([
		[
			// Whether or not it falls on the same UTC day.
			"an older confirmation",
			{ ...v2, revision: newRevision, sourceDate: newSource, confirmedAt: iso(nowSeconds - 60) },
			/older confirmation/,
		],
		[
			"a new revision without a newer source",
			{ ...v2, revision: newRevision },
			/newer source date/,
		],
		["a future confirmation", { ...v2, confirmedAt: iso(nowSeconds + 120) }, /future/],
		[
			"a confirmation over an hour old",
			{ ...v2, confirmedAt: iso(nowSeconds - 2 * 3600) },
			/one hour/,
		],
		[
			"an expired confirmation",
			{ ...v2, sourceDate: iso(nowSeconds - 30 * day), confirmedAt: iso(nowSeconds - 30 * day) },
			/expired/,
		],
		[
			"changed rates at the same revision",
			{ ...v2, rates: { ...v2.rates, "seedream-5.5": { kind: "unavailable" } } },
			/changed/,
		],
		[
			"an unknown model in a required one's place",
			{ ...v2, rates: { "z-image": v2.rates["z-image"], extra: { kind: "unavailable" } } },
			/Invalid/,
		],
		["a v1 feed", bundledV1, /Invalid/],
	])("rejects %s without moving the branch", (_, candidate, reason) => {
		const published = seedV2(v2);
		const result = publish(candidate);
		expect(result.success).toBe(false);
		expect(result.err).toMatch(reason);
		expect(head()).toBe(published);
	});

	test("rejects a revised license without moving the branch", () => {
		const published = seedV2(v2);
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

	test.each([
		["an unfamiliar", h3Fixture.rates["h3-max"]],
		["the z-image", bundledV2.rates["z-image"]],
	])("projects %s kind at seedream-5.5 as unavailable in v1", (_, rate) => {
		const candidate = { ...v2, rates: { ...v2.rates, "seedream-5.5": rate } };
		const result = publish(candidate);
		if (!result.success) throw new Error(result.err);
		expect(JSON.parse(show(v2Path))).toEqual(candidate);
		const v1 = JSON.parse(show(v1Path));
		expect(v1.rates).toEqual({
			"z-image": v2.rates["z-image"],
			"seedream-5.5": { kind: "unavailable" },
		});
		expect(decodePricingFeed(v1)).toEqual(v1);
	});

	test("the collector's h3-max entry reaches v2 at the same revision and leaves v1 bytes unchanged", () => {
		const shippedBytes = readFileSync(resolve(import.meta.dir, "../..", v1Path));
		seedV2({ ...v2, confirmedAt: yesterday });
		const v1Blob = blob(v1Path);
		const withH3 = { ...v2, rates: { ...v2.rates, "h3-max": h3Fixture.rates["h3-max"] } };
		const result = publish(withH3);
		if (!result.success) throw new Error(result.err);
		expect(JSON.parse(show(v2Path))).toEqual(withH3);
		expect(JSON.parse(show(v2Path)).revision).toBe(v2.revision);
		expect(blob(v1Path)).toBe(v1Blob);
		expect(readFileSync(resolve(import.meta.dir, "../..", v1Path))).toEqual(shippedBytes);
	});

	test.each([
		{ kind: "per-second-by-resolution", resolutions: { "480p": "0" } },
		{ kind: "per-second-by-resolution", resolutions: {} },
		{ kind: "per-second-by-resolution", resolutions: { "4K": "10" } },
		{ kind: "per-second-by-resolution", resolutions: { "480p": "10" }, extra: "1" },
		{ kind: "per-second-by-resolution", resolutions: { "480p": { a: "1" } } },
	])("rejects a malformed per-second rate %#", (rate) => {
		const result = publish({ ...v2, rates: { ...v2.rates, "h3-max": rate } });
		expect(result.err).toContain("Invalid PoYo v2 pricing feed handoff");
		expect(git(remote, "for-each-ref")).toBe("");
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
		writeFileSync(
			collected,
			JSON.stringify({ feed: largest, basis: basisFor(largest) }, null, "\t"),
		);
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
		writeFileSync(
			resolve(client, "bundled-v2.json"),
			JSON.stringify({ ...bundledV2, confirmedAt: bundledV2.sourceDate }),
		);
		const refreshed = await refreshPricingFeed({
			bundledPath: resolve(client, "bundled-v1.json"),
			cachePath: resolve(client, "v1.json"),
			v2BundledPath: resolve(client, "bundled-v2.json"),
			v2CachePath: resolve(client, "v2.json"),
			// The published basis pairs with the published feed as refresh reads it.
			fetchFeed: async (url) =>
				new Response(url.endsWith("/poyo-basis.json") ? show(basisPath) : body),
		});
		expect<unknown>(refreshed.feed).toEqual(largest);
		expect(JSON.parse(readFileSync(resolve(client, "poyo-basis.json"), "utf8"))).toEqual(
			JSON.parse(show(basisPath)),
		);
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

describe("PoYo price basis publication", () => {
	const handoffLimit = 120 * 1024;
	const tree = () => git(remote, "ls-tree", "-r", "--name-only", ref).split("\n").filter(Boolean);
	/** A handoff of exactly `bytes` bytes: a valid pair padded with trailing spaces. */
	function sizedHandoff(bytes: number) {
		const text = JSON.stringify({ feed: v2, basis: basisFor(v2) });
		return text + " ".repeat(bytes - text.length);
	}

	test("reads at most 120 KiB of the handoff and refuses one byte more", () => {
		expect(publish(sizedHandoff(handoffLimit)).success).toBe(true);
		rmSync(remote, { recursive: true, force: true });
		git(sandbox, "init", "--bare", remote);
		const over = publish(sizedHandoff(handoffLimit + 1));
		expect(over.err).toMatch(/handoff exceeds the size limit/);
		expect(git(remote, "for-each-ref")).toBe("");
	});

	test.each([
		["a bare feed", JSON.stringify(v2)],
		["an extra member", JSON.stringify({ feed: v2, basis: basisFor(v2), extra: 1 })],
		["two objects", `${JSON.stringify({ feed: v2, basis: basisFor(v2) })}{}`],
		["no JSON", "{"],
	])("refuses %s without publishing", (_, handoff) => {
		expect(publish(handoff).err).toMatch(/Invalid PoYo pricing handoff/);
		expect(git(remote, "for-each-ref")).toBe("");
	});

	test.each<[string, unknown, RegExp]>([
		["another revision", { ...basisFor(v2), revision: newRevision }, /revision/],
		["another feed digest", { ...basisFor(v2), feedSha256: "f".repeat(64) }, /does not match/],
		[
			"the digest of the blob with its LF",
			{ ...basisFor(v2), feedSha256: sha256(`${canonicalJson(v2)}\n`) },
			/does not match/,
		],
		[
			"an uppercase digest",
			{ ...basisFor(v2), feedSha256: "A".repeat(64) },
			/Invalid PoYo price basis/,
		],
		["an extra field", { ...basisFor(v2), extra: "1" }, /Invalid PoYo price basis/],
		["a bad rate key", basisFor(v2, { _bad: "0".repeat(64) }), /Invalid PoYo price basis/],
		["a short digest", basisFor(v2, { "z-image": "0" }), /Invalid PoYo price basis/],
		["a list of digests", { ...basisFor(v2), digests: [] }, /Invalid PoYo price basis/],
		[
			"a basis over 32 KiB",
			basisFor(
				v2,
				Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`m${i}`, "0".repeat(64)])),
			),
			/size limit/,
		],
	])("refuses a basis with %s, publishing neither file", (_, basis, reason) => {
		const published = seedV2({ ...v2, confirmedAt: yesterday });
		const result = publish(v2, license, basis as ReturnType<typeof basisFor>);
		expect(result.success).toBe(false);
		expect(result.err).toMatch(reason);
		expect(head()).toBe(published);
	});

	test("a feed publish-v2.jq accepts decodes unchanged, so both languages agree on its digest", () => {
		const filter = resolve(import.meta.dir, "providers/poyo/publish-v2.jq");
		const fixture = { ...pair.feed, confirmedAt: now };
		for (const feed of [v2, fixture, { ...v2, revision: v2.revision.toUpperCase() }]) {
			const jq = Bun.spawnSync(["jq", "-RsceS", "-L", import.meta.dir, "-f", filter], {
				stdin: new TextEncoder().encode(JSON.stringify(feed)),
				stdout: "pipe",
				stderr: "pipe",
			});
			const decoded = decodePoyoV2Feed(feed);
			if (!jq.success) {
				expect(decoded?.revision).not.toBe(feed.revision);
				continue;
			}
			expect(canonicalJson(decoded)).toBe(jq.stdout.toString().trimEnd());
		}
		// The shared fixture, with its numeric keys, publishes with the digest TypeScript computes.
		const result = publish(fixture, license, {
			...pair.basis,
			feedSha256: sha256(canonicalJson(decodePoyoV2Feed(fixture))),
		});
		if (!result.success) throw new Error(result.err);
		const published = show(v2Path);
		expect(JSON.parse(show(basisPath)).feedSha256).toBe(sha256(published.trimEnd()));
		expect(JSON.parse(show(basisPath)).digests).toEqual(pair.basis.digests);
	});

	test("a branch without a basis passes the tree check and the next publish adds it", () => {
		const seeded = seedV2({ ...v2, confirmedAt: yesterday });
		const result = publish(v2);
		if (!result.success) throw new Error(result.err);
		expect(git(remote, "rev-parse", `${ref}^`).trim()).toBe(seeded);
		expect(tree()).toContain(basisPath);
		expect(JSON.parse(show(basisPath))).toEqual(basisFor(v2));
	});

	test("a basis on a branch without a v2 feed is unexpected contents", () => {
		seed({
			[v1Path]: `${JSON.stringify(bundledV1)}\n`,
			[v1LicensePath]: licenseText,
			[basisPath]: `${canonicalJson(basisFor(v2))}\n`,
		});
		expect(publish(v2).err).toContain("Unexpected contents");
	});

	test("an unchanged feed still publishes a missing or changed basis, and an unchanged pair skips", () => {
		const seeded = seedV2(v2);
		expect(publish(v2).success).toBe(true);
		expect(git(remote, "rev-parse", `${ref}^`).trim()).toBe(seeded);
		const withBasis = head();
		const v2Blob = blob(v2Path);
		const changed = basisFor(v2, { "z-image": "1".repeat(64) });
		expect(publish(v2, license, changed).success).toBe(true);
		expect(git(remote, "rev-parse", `${ref}^`).trim()).toBe(withBasis);
		expect(blob(v2Path)).toBe(v2Blob);
		expect(JSON.parse(show(basisPath))).toEqual(changed);
		const published = head();
		const rerun = publish(v2, license, changed);
		expect(rerun.out).toContain("PoYo pricing is unchanged.");
		expect(head()).toBe(published);
	});

	test("a same-day confirmation skips only while the basis keeps its revision and digests", () => {
		expect(publish({ ...v2, confirmedAt: earlierToday }).success).toBe(true);
		const published = head();
		// The feed digest follows the confirmation, so it alone never forces a publish.
		const skipped = publish(v2);
		expect(skipped.out).toContain("PoYo pricing was already confirmed today.");
		expect(head()).toBe(published);
		const changed = basisFor(v2, { "z-image": "1".repeat(64) });
		const result = publish(v2, license, changed);
		if (!result.success) throw new Error(result.err);
		expect(git(remote, "rev-parse", `${ref}^`).trim()).toBe(published);
		expect(JSON.parse(show(v2Path)).confirmedAt).toBe(now);
		expect(JSON.parse(show(basisPath))).toEqual(changed);
	});

	test("a same-day confirmation publishes a basis the branch lacks", () => {
		const seeded = seedV2({ ...v2, confirmedAt: earlierToday });
		const result = publish(v2);
		if (!result.success) throw new Error(result.err);
		expect(git(remote, "rev-parse", `${ref}^`).trim()).toBe(seeded);
		expect(JSON.parse(show(basisPath))).toEqual(basisFor(v2));
	});

	test("the same revision may drop a derived rate that main no longer queues, never a shipped one", () => {
		const derived = { kind: "per-request", credits: "4" } as const;
		const withDerived = { ...v2, rates: { ...v2.rates, "gpt-4o-image": derived } };
		const both = { "z-image": "0".repeat(64), "gpt-4o-image": "1".repeat(64) };
		const seeded = seed({
			[v1Path]: `${JSON.stringify(bundledV1)}\n`,
			[v1LicensePath]: licenseText,
			[v2Path]: `${JSON.stringify({ ...withDerived, confirmedAt: yesterday })}\n`,
			[v2LicensePath]: licenseText,
			[basisPath]: `${canonicalJson(basisFor({ ...withDerived, confirmedAt: yesterday }, both))}\n`,
		});
		// A queue row on main went back to pending, so the collector no longer derives its rate.
		const result = publish(v2);
		if (!result.success) throw new Error(result.err);
		expect(git(remote, "rev-parse", `${ref}^`).trim()).toBe(seeded);
		expect(Object.keys(JSON.parse(show(v2Path)).rates)).not.toContain("gpt-4o-image");
		// A rate the basis does not bind is a shipped rate, and removing it still fails.
		const published = head();
		const withoutZImage = { ...v2, rates: { "seedream-5.5": v2.rates["seedream-5.5"] } };
		const refused = publish(withoutZImage, license, basisFor(withoutZImage, {}));
		expect(refused.success).toBe(false);
		expect(head()).toBe(published);
	});

	test("a dropped rate stays refused when the published basis pairs with another revision", () => {
		const derived = { kind: "per-request", credits: "4" } as const;
		const withDerived = { ...v2, rates: { ...v2.rates, "gpt-4o-image": derived } };
		const published = seed({
			[v1Path]: `${JSON.stringify(bundledV1)}\n`,
			[v1LicensePath]: licenseText,
			[v2Path]: `${JSON.stringify({ ...withDerived, confirmedAt: yesterday })}\n`,
			[v2LicensePath]: licenseText,
			[basisPath]: `${canonicalJson({
				...basisFor(withDerived, { "gpt-4o-image": "1".repeat(64) }),
				revision: newRevision,
			})}\n`,
		});
		expect(publish(v2).err).toMatch(/removed a published rate/);
		expect(head()).toBe(published);
	});

	test("an invalid published basis stops the publisher", () => {
		const published = seed({
			[v1Path]: `${JSON.stringify(bundledV1)}\n`,
			[v1LicensePath]: licenseText,
			[v2Path]: `${JSON.stringify({ ...v2, confirmedAt: yesterday })}\n`,
			[v2LicensePath]: licenseText,
			[basisPath]: "{}\n",
		});
		expect(publish(v2).err).toMatch(/Invalid PoYo price basis/);
		expect(head()).toBe(published);
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
