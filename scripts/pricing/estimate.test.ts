import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import bundledV2 from "../../pricing/v2/poyo.json";
import { estimatePrice } from "../../src/lib/shared/pricing/estimate";
import h3Feed from "../../tests/fixtures/h3-rate.v2.json";
import { toapisRates } from "../../tests/fixtures/toapis-feed";
import { readEstimateArgs } from "./estimate";
import { loadLocalPricing, pricingCachePath } from "./local-feed";

test("a CLI estimate preserves the selected edit and batch", () => {
	const input = readEstimateArgs([
		"--model",
		"seedream-5.5",
		"--operation",
		"edit",
		"--resolution",
		"2K",
		"--references",
		"2",
		"--batch",
		"5",
		"--retries",
		"3",
	]);
	expect(input).toEqual({
		provider: "poyo",
		model: "seedream-5.5",
		operation: "edit",
		options: { resolution: "2K" },
		sourceCount: 2,
		count: 5,
		retryLimit: 3,
	});
});

test("an invalid CLI flag or non-integer count cannot become a default estimate", () => {
	expect(() => readEstimateArgs(["--model", "z-image", "--batch", ""])).toThrow();
	expect(() => readEstimateArgs(["--model", "z-image", "--batch", "1.5"])).toThrow();
	expect(() => readEstimateArgs(["--model", "z-image", "--unknown", "1"])).toThrow();
	expect(() => readEstimateArgs([])).toThrow();
});

test("the offline CLI selects the ToAPIs cache and uses the same tier and attempt semantics", async () => {
	const directory = await mkdtemp(join(tmpdir(), "siluet-cli-pricing-"));
	try {
		const cache = pricingCachePath(directory, "toapis");
		const now = new Date().toISOString();
		const rate = toapisRates.rates.find(({ usd }) => usd === "0.028");
		const fixture = {
			...toapisRates,
			observedAt: now.replace(/\.\d{3}Z$/, "Z"),
			rates: toapisRates.rates.map((entry) =>
				entry === rate ? { ...entry, usd: "0.03", approximateCredits: "6" } : entry,
			),
		};
		await mkdir(dirname(cache), { recursive: true });
		await writeFile(cache, JSON.stringify({ checkedAt: now, feed: fixture }));
		const proc = Bun.spawn(
			[
				process.execPath,
				"run",
				"pricing:estimate",
				"--provider",
				"toapis",
				"--model",
				"doubao-seedream-5-5",
				"--operation",
				"edit",
				"--references",
				"2",
				"--size",
				"2K",
				"--batch",
				"5",
				"--retries",
				"3",
			],
			{
				cwd: new URL("../../", import.meta.url).pathname,
				env: { ...process.env, XDG_CACHE_HOME: directory },
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		if (exitCode !== 0) throw new Error(stderr);
		expect(JSON.parse(stdout)).toMatchObject({
			status: "known",
			unit: "toapis_credit",
			perRequest: "6",
			batch: "30",
			maxAttempts: 20,
			source: { scope: "public-advertised" },
		});
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("the CLI distinguishes image, mixed and unspecified Seedance sources", () => {
	const args = ["--provider", "toapis", "--model", "seedance-2-5"];
	const now = Date.parse("2026-11-21T12:00:00Z");
	for (const [media, usd] of [
		[["--source-kind", "image"], "10"],
		[["--source-kind", "image", "--source-kind", "video"], "6"],
	] as const) {
		expect(estimatePrice(toapisRates, readEstimateArgs([...args, ...media]), now)).toMatchObject({
			status: "unknown",
			reason: "token-usage-unknown",
			advertisedUnitRate: { usd },
		});
	}
	expect(
		estimatePrice(toapisRates, readEstimateArgs([...args, "--references", "1"]), now),
	).toMatchObject({
		status: "unknown",
		reason: "unsupported-input",
	});
	expect(() => readEstimateArgs([...args, "--source-kind", "file"])).toThrow();
	expect(() =>
		readEstimateArgs([...args, "--references", "2", "--source-kind", "image"]),
	).toThrow();
});

test("the release bundles estimate both providers offline with an empty cache", async () => {
	const directory = await mkdtemp(join(tmpdir(), "siluet-bundled-rates-"));
	try {
		for (const [provider, args, credits] of [
			[
				"poyo",
				[
					"--model",
					"seedream-5.5",
					"--resolution",
					"2K",
					"--operation",
					"edit",
					"--references",
					"2",
				],
				"10.2",
			],
			["toapis", ["--model", "doubao-seedream-5-5", "--size", "2K"], "5.6"],
		] as const) {
			const now = Date.parse("2026-11-21T16:00:00Z");
			const feed = await loadLocalPricing(now, {
				provider,
				cachePath: pricingCachePath(directory, provider),
				v2CachePath: pricingCachePath(directory, "poyo-v2"),
			});
			const input = readEstimateArgs(["--provider", provider, ...args]);
			expect(estimatePrice(feed, input, now)).toMatchObject({
				status: "known",
				perRequest: credits,
			});
		}
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("a v2-backed CLI request for 5 s at 768p returns 80 credits", async () => {
	const directory = await mkdtemp(join(tmpdir(), "siluet-h3-rates-"));
	try {
		const cache = pricingCachePath(directory, "poyo-v2");
		await mkdir(dirname(cache), { recursive: true });
		// A later confirmation of the bundled revision whose collector added the H3 rate. An
		// older confirmation would be a rollback, so the bundled feed would win.
		const confirmedAt = new Date(Date.parse(bundledV2.confirmedAt) + 3_600_000)
			.toISOString()
			.replace(".000Z", "Z");
		const confirmed = {
			...bundledV2,
			confirmedAt,
			rates: { ...bundledV2.rates, "h3-max": h3Feed.rates["h3-max"] },
		};
		await writeFile(cache, JSON.stringify({ checkedAt: confirmedAt, feed: confirmed }));
		const now = Date.parse(confirmedAt) + 86_400_000;
		const feed = await loadLocalPricing(now, {
			provider: "poyo",
			cachePath: pricingCachePath(directory, "poyo"),
			v2CachePath: cache,
		});
		const defaults = readEstimateArgs(["--model", "h3-max"]);
		expect(defaults.options).toEqual({
			duration: 5,
			resolution: "768p",
			aspect_ratio: "16:9",
			enable_safety_checker: false,
		});
		expect(estimatePrice(feed, defaults, now)).toMatchObject({ status: "known", perRequest: "80" });
		const ten = readEstimateArgs(["--model", "h3-max", "--duration", "10", "--resolution", "480p"]);
		expect(estimatePrice(feed, ten, now)).toMatchObject({ status: "known", perRequest: "100" });
		expect(
			estimatePrice(feed, readEstimateArgs(["--model", "h3-max", "--references", "1"]), now),
		).toMatchObject({ status: "unknown", reason: "unsupported-input" });
		expect(() => readEstimateArgs(["--model", "h3-max", "--duration", "5.5"])).toThrow(
			"--duration",
		);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
