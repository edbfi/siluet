import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import bundledV1 from "../../pricing/v1/feed.json";
import {
	decodeToapisPricingFeed,
	toapisFeedExpiryMs,
} from "../../src/lib/shared/pricing/toapis-feed";
import { poyoV2Feed } from "../../tests/fixtures/poyo-v2-feed";
import { toapisRates } from "../../tests/fixtures/toapis-feed";
import { checkPricingFreshness, readFreshnessArgs } from "./freshness";

const day = 24 * 60 * 60 * 1000;
const confirmed = Date.parse(poyoV2Feed.confirmedAt);
const daysLeft = (days: number) => confirmed + (30 - days) * day;
let directory: string;
const path = (name: string) => resolve(directory, name);

beforeEach(() => {
	directory = mkdtempSync(resolve(tmpdir(), "siluet-freshness-"));
	writeFileSync(path("v2.json"), JSON.stringify(poyoV2Feed));
	writeFileSync(path("v1.json"), JSON.stringify(bundledV1));
	writeFileSync(path("toapis.json"), JSON.stringify(toapisRates));
});

afterEach(() => {
	rmSync(directory, { recursive: true, force: true });
});

const defaults = readFreshnessArgs(["--poyo-v2", "unused"]);

function check(options: Partial<typeof defaults>, nowMs: number) {
	return checkPricingFreshness({ ...defaults, poyoV2: undefined, ...options }, nowMs);
}

describe("published PoYo freshness", () => {
	test.each([
		[20, "notice"],
		[14.5, "notice"],
		[14, "warning"],
		[7.5, "warning"],
		[7, "error"],
		[0, "error"],
	] as const)("%d days left is a %s", async (left, level) => {
		expect(await check({ poyoV2: path("v2.json") }, daysLeft(left))).toEqual([
			{
				level,
				message: `Published PoYo v2 rates expire 2026-12-22T13:30:00Z (${left.toFixed(1)} days left).`,
			},
		]);
	});

	test("checks v1 only while the v2 feed is absent", async () => {
		const at = daysLeft(20);
		expect(await check({ poyoV2: path("v2.json"), poyoV1: path("v1.json") }, at)).toEqual([
			expect.objectContaining({ level: "notice", message: expect.stringContaining("v2") }),
		]);
		expect(await check({ poyoV2: path("absent.json"), poyoV1: path("v1.json") }, at)).toEqual([
			expect.objectContaining({
				level: "notice",
				message: expect.stringContaining("v1 rates expire"),
			}),
		]);
	});

	test.each([
		["missing", "absent.json", undefined],
		["invalid", "bad.json", "{"],
		["v1-shaped", "bad.json", JSON.stringify(bundledV1)],
		[
			"confirmed after the clock",
			"future.json",
			JSON.stringify({ ...poyoV2Feed, confirmedAt: "2026-12-01T00:00:00Z" }),
		],
	])("fails on a %s feed", async (_, name, content) => {
		if (content !== undefined) writeFileSync(path(name), content);
		const [result] = await check({ poyoV2: path(name) }, Date.parse("2026-11-30T00:00:00Z"));
		expect(result.level).toBe("error");
	});
});

test("the bundled feed uses the same thresholds", async () => {
	for (const [left, level] of [
		[15, "notice"],
		[8, "warning"],
		[7, "error"],
	] as const) {
		expect(await check({ bundledPoyo: path("v2.json") }, daysLeft(left))).toEqual([
			{ level, message: expect.stringMatching(/^Bundled PoYo rates on main expire /) },
		]);
	}
});

test("ToAPIs uses its own effective expiry", async () => {
	const aged = { ...toapisRates, conversionCacheAgeSeconds: 3 * 86_400 };
	writeFileSync(path("toapis.json"), JSON.stringify(aged));
	const feed = decodeToapisPricingFeed(aged);
	if (!feed) throw new Error("Invalid ToAPIs fixture");
	const expires = toapisFeedExpiryMs(feed);
	expect(expires).toBe(Date.parse(aged.observedAt) + 27 * day);
	expect(await check({ toapis: path("toapis.json") }, expires - 10 * day)).toEqual([
		{
			level: "warning",
			message: `Published ToAPIs rates expire ${new Date(expires).toISOString().replace(".000Z", "Z")} (10.0 days left).`,
		},
	]);
});

test("the command reports every feed before failing and writes the summary", () => {
	const summary = path("summary.md");
	writeFileSync(path("bad.json"), "{");
	const result = Bun.spawnSync(
		[
			process.execPath,
			resolve(import.meta.dir, "freshness.ts"),
			"--poyo-v2",
			path("bad.json"),
			"--toapis",
			path("toapis.json"),
			"--bundled-poyo",
			path("v2.json"),
			"--fail-within-days",
			"14",
		],
		{ env: { ...process.env, GITHUB_STEP_SUMMARY: summary }, stdout: "pipe", stderr: "pipe" },
	);
	expect(result.exitCode).toBe(1);
	const lines = result.stdout.toString().trim().split("\n");
	expect(lines).toHaveLength(3);
	expect(lines[0]).toStartWith(
		"::error title=Pricing freshness::Published PoYo v2 rates are missing or invalid.",
	);
	expect(lines[1]).toMatch(
		/^::(notice|warning|error) title=Pricing freshness::Published ToAPIs rates/,
	);
	expect(lines[2]).toMatch(/^::(notice|warning|error) title=Pricing freshness::Bundled PoYo rates/);
	expect(readFileSync(summary, "utf8").trim().split("\n")).toHaveLength(3);
});

test("arguments require a feed and ordered thresholds", () => {
	expect(defaults).toMatchObject({ warnWithinDays: 14, failWithinDays: 7 });
	expect(() => readFreshnessArgs([])).toThrow(/at least one/);
	expect(() => readFreshnessArgs(["--toapis", "x", "--warn-within-days", "5"])).toThrow();
	expect(() => readFreshnessArgs(["--toapis", "x", "--fail-within-days", "1.5"])).toThrow();
	expect(readFreshnessArgs(["--toapis", "x", "--fail-within-days", "14"])).toMatchObject({
		failWithinDays: 14,
		warnWithinDays: 14,
	});
});
