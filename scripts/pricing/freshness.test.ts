import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
	decodeToapisPricingFeed,
	toapisFeedExpiryMs,
} from "../../src/lib/shared/pricing/toapis-feed";
import pair from "../../tests/fixtures/poyo-basis-pair.json";
import { poyoV1Feed, poyoV2Feed, sizedPoyoV2Feed } from "../../tests/fixtures/poyo-v2-feed";
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
	writeFileSync(path("v1.json"), JSON.stringify(poyoV1Feed));
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
		["v1-shaped", "bad.json", JSON.stringify(poyoV1Feed)],
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

describe("publication size limits", () => {
	const at = daysLeft(20);
	/** Write compact JSON padded with spaces to exactly `bytes`, including the trailing LF. */
	function padded(name: string, value: unknown, bytes: number) {
		const json = JSON.stringify(value);
		writeFileSync(path(name), `${json}${" ".repeat(bytes - json.length - 1)}\n`);
		return path(name);
	}

	test("a published v2 feed may be 64 KiB including its LF", async () => {
		const largest = sizedPoyoV2Feed(65_536);
		writeFileSync(path("v2.json"), `${JSON.stringify(largest)}\n`);
		const [fits] = await check({ poyoV2: path("v2.json") }, at);
		expect(fits.level).toBe("notice");
		writeFileSync(path("v2.json"), `${JSON.stringify(sizedPoyoV2Feed(65_537))}\n`);
		expect(await check({ poyoV2: path("v2.json") }, at)).toEqual([
			{ level: "error", message: "Published PoYo v2 rates are missing or invalid." },
		]);
	});

	test.each([
		["poyoV1", poyoV1Feed, "Published PoYo v1 rates"],
		["toapis", toapisRates, "Published ToAPIs v2 rates"],
	] as const)(
		"a published %s feed may be 4096 bytes including its LF",
		async (key, feed, label) => {
			const [fits] = await check({ [key]: padded("feed.json", feed, 4096) }, at);
			expect(fits.message).toStartWith(`${label} expire`);
			expect(await check({ [key]: padded("feed.json", feed, 4097) }, at)).toEqual([
				{ level: "error", message: `${label} are missing or invalid.` },
			]);
		},
	);

	test("a bundled feed keeps the 256 KiB local file limit", async () => {
		const bundled = path("bundled.json");
		writeFileSync(bundled, `${JSON.stringify(sizedPoyoV2Feed(65_537))}\n`);
		const [fits] = await check({ bundledPoyo: bundled }, at);
		expect(fits.message).toStartWith("Bundled PoYo rates on main expire");
		const [over] = await check(
			{ bundledPoyo: padded("bundled.json", poyoV2Feed, 256 * 1024 + 1) },
			at,
		);
		expect(over.message).toBe("Bundled PoYo rates on main are missing or invalid.");
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

describe("ToAPIs v2 freshness", () => {
	const at = Date.parse(toapisRates.observedAt) + day;

	test("checks the published and bundled v2 feeds with their own limits", async () => {
		const bundled = path("bundled-toapis.json");
		writeFileSync(bundled, JSON.stringify(toapisRates, null, "\t").padEnd(64 * 1024, " "));
		expect(await check({ toapis: path("toapis.json"), bundledToapis: bundled }, at)).toEqual([
			expect.objectContaining({
				message: expect.stringMatching(/^Published ToAPIs v2 rates expire /),
			}),
			expect.objectContaining({
				message: expect.stringMatching(/^Bundled ToAPIs rates on main expire /),
			}),
		]);
		expect(await check({ toapis: bundled }, at)).toEqual([
			{ level: "error", message: "Published ToAPIs v2 rates are missing or invalid." },
		]);
	});

	test("reports the frozen v1 shape as invalid", async () => {
		const { receiptDelaySeconds: _delays, ...fields } = toapisRates;
		const v1 = {
			...fields,
			version: 1,
			rates: toapisRates.rates.filter((rate) => rate.unit !== "reference-image"),
		};
		writeFileSync(path("v1-toapis.json"), JSON.stringify(v1));
		expect(
			await check({ toapis: path("v1-toapis.json"), bundledToapis: path("v1-toapis.json") }, at),
		).toEqual([
			{ level: "error", message: "Published ToAPIs v2 rates are missing or invalid." },
			{ level: "error", message: "Bundled ToAPIs rates on main are missing or invalid." },
		]);
	});
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
			message: `Published ToAPIs v2 rates expire ${new Date(expires).toISOString().replace(".000Z", "Z")} (10.0 days left).`,
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
			"--bundled-toapis",
			path("toapis.json"),
			"--fail-within-days",
			"14",
		],
		{ env: { ...process.env, GITHUB_STEP_SUMMARY: summary }, stdout: "pipe", stderr: "pipe" },
	);
	expect(result.exitCode).toBe(1);
	const lines = result.stdout.toString().trim().split("\n");
	expect(lines).toHaveLength(4);
	expect(lines[0]).toStartWith(
		"::error title=Pricing freshness::Published PoYo v2 rates are missing or invalid.",
	);
	expect(lines[1]).toMatch(
		/^::(notice|warning|error) title=Pricing freshness::Published ToAPIs v2 rates/,
	);
	expect(lines[2]).toMatch(/^::(notice|warning|error) title=Pricing freshness::Bundled PoYo rates/);
	expect(lines[3]).toMatch(
		/^::(notice|warning|error) title=Pricing freshness::Bundled ToAPIs rates/,
	);
	expect(readFileSync(summary, "utf8").trim().split("\n")).toHaveLength(4);
});

describe("the PoYo price basis", () => {
	const at = Date.parse(pair.feed.confirmedAt) + day;
	const published = "Published PoYo price basis";
	const bundled = "Bundled PoYo price basis on main";
	beforeEach(() => {
		writeFileSync(path("pair-feed.json"), JSON.stringify(pair.feed));
		writeFileSync(path("pair-basis.json"), JSON.stringify(pair.basis));
	});
	const basisCheck = async (options: Partial<typeof defaults>) =>
		(await check(options, at)).find(({ message }) => message.includes("price basis"));

	test("a pair with the same revision and feed digest is healthy, published and bundled", async () => {
		expect(
			await check(
				{
					poyoV2: path("pair-feed.json"),
					poyoBasis: path("pair-basis.json"),
					bundledPoyo: path("pair-feed.json"),
					bundledPoyoBasis: path("pair-basis.json"),
				},
				at,
			),
		).toEqual([
			expect.objectContaining({ level: "notice", message: expect.stringContaining("v2 rates") }),
			{ level: "notice", message: `${published} pairs with revision 0123456789ab.` },
			expect.objectContaining({ level: "notice", message: expect.stringContaining("Bundled") }),
			{ level: "notice", message: `${bundled} pairs with revision 0123456789ab.` },
		]);
	});

	test.each([
		["missing", undefined, "error", `${published} is missing or invalid.`],
		["invalid", "{", "error", `${published} is missing or invalid.`],
		[
			"for another revision",
			JSON.stringify({ ...pair.basis, revision: "f".repeat(40) }),
			"error",
			`${published} does not pair with the published v2 rates.`,
		],
		[
			"for another body",
			JSON.stringify({ ...pair.basis, feedSha256: "f".repeat(64) }),
			"error",
			`${published} does not pair with the published v2 rates.`,
		],
	] as const)("an error: the published basis is %s", async (_, content, level, message) => {
		if (content !== undefined) writeFileSync(path("basis.json"), content);
		const options = { poyoV2: path("pair-feed.json"), poyoBasis: path("basis.json") };
		expect(await basisCheck(options)).toEqual({ level, message });
	});

	test.each([
		[
			"unstaged",
			undefined,
			`${bundled} is absent. Derived rows stay unknown-price until a re-bundle adds it.`,
		],
		[
			"for another revision",
			JSON.stringify({ ...pair.basis, revision: "f".repeat(40) }),
			`${bundled} does not pair with the bundled rates. Derived rows stay unknown-price until a re-bundle pairs them.`,
		],
		[
			"invalid",
			"{",
			`${bundled} does not pair with the bundled rates. Derived rows stay unknown-price until a re-bundle pairs them.`,
		],
	] as const)("a warning: the bundled basis is %s", async (_, content, message) => {
		if (content !== undefined) writeFileSync(path("basis.json"), content);
		const options = { bundledPoyo: path("pair-feed.json"), bundledPoyoBasis: path("basis.json") };
		expect(await basisCheck(options)).toEqual({ level: "warning", message });
	});

	test("a v1 bundled feed cannot pair with a basis", async () => {
		const options = { bundledPoyo: path("v1.json"), bundledPoyoBasis: path("pair-basis.json") };
		expect(await basisCheck(options)).toMatchObject({ level: "warning" });
	});

	test("a basis is checked only beside its feed, and without the flags nothing changes", async () => {
		const options = { poyoV2: path("pair-feed.json"), bundledPoyo: path("pair-feed.json") };
		expect(await check(options, at)).toHaveLength(2);
		expect(() => readFreshnessArgs(["--toapis", "t", "--poyo-basis", "x"])).toThrow(
			/--poyo-basis needs --poyo-v2/,
		);
		expect(() => readFreshnessArgs(["--toapis", "t", "--bundled-poyo-basis", "x"])).toThrow(
			/--bundled-poyo-basis needs --bundled-poyo/,
		);
		expect(
			readFreshnessArgs([
				"--poyo-v2",
				"a",
				"--poyo-basis",
				"b",
				"--bundled-poyo",
				"c",
				"--bundled-poyo-basis",
				"d",
			]),
		).toMatchObject({ poyoBasis: "b", bundledPoyoBasis: "d" });
	});

	test("the pricing workflow stages both bases and passes them to the check", () => {
		const workflow = readFileSync(
			resolve(import.meta.dir, "../../.github/workflows/pricing.yml"),
			"utf8",
		);
		expect(workflow).toContain("pricing-data:pricing/v2/poyo-basis.json:poyo-basis.json");
		expect(workflow).toContain("main:pricing/v2/poyo-basis.json:bundled-poyo-basis.json");
		expect(workflow).toContain('--poyo-basis "$RUNNER_TEMP/pricing-feeds/poyo-basis.json"');
		expect(workflow).toContain(
			'--bundled-poyo-basis "$RUNNER_TEMP/pricing-feeds/bundled-poyo-basis.json"',
		);
	});
});

test("arguments require a feed and ordered thresholds", () => {
	expect(defaults).toMatchObject({ warnWithinDays: 14, failWithinDays: 7 });
	expect(() => readFreshnessArgs([])).toThrow(/at least one/);
	expect(readFreshnessArgs(["--bundled-toapis", "x"])).toMatchObject({ bundledToapis: "x" });
	expect(() => readFreshnessArgs(["--toapis", "x", "--warn-within-days", "5"])).toThrow();
	expect(() => readFreshnessArgs(["--toapis", "x", "--fail-within-days", "1.5"])).toThrow();
	expect(readFreshnessArgs(["--toapis", "x", "--fail-within-days", "14"])).toMatchObject({
		failWithinDays: 14,
		warnWithinDays: 14,
	});
});
