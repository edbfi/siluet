import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { decodeToapisPricingFeed } from "../../src/lib/shared/pricing/toapis-feed";

const ref = "refs/heads/pricing-data-toapis";
const feedPath = "pricing/v1/toapis.json";
const script = resolve(import.meta.dir, "publish.sh");

function source(model: string) {
	return {
		url: `https://toapis.com/model-guide/${model}`,
		scope: "public-advertised",
		region: "global-site",
		tier: null,
		publishedAt: null,
		cacheAgeSeconds: null,
	};
}

const imageModel = "doubao-seedream-5-5";
const videoModel = "seedance-2-5";
const daySeconds = 86_400;
const today = Date.now();
const simulatedDay = (daysAgo: number) =>
	new Date(today - daysAgo * daySeconds * 1000).toISOString().slice(0, 10);
const observed = (daysAgo: number, time = "00:00:00") => `${simulatedDay(daysAgo)}T${time}Z`;
const observation = {
	version: 1,
	provider: "toapis",
	observedAt: observed(4),
	creditsPerUsd: "200",
	conversionSourceUrl: "https://toapis.com/pricing",
	conversionCacheAgeSeconds: null,
	rates: [
		...["1K", "1.5K", "2K"].map((size) => ({
			model: imageModel,
			operations: ["generate", "edit"],
			unit: "image",
			conditions: { size, outputCount: 1, layerDecomposition: false },
			usd: "0.014125",
			approximateCredits: "2.825",
			source: source(imageModel),
		})),
		...[false, true].map((videoInput) => ({
			model: videoModel,
			operations: ["generate", "edit"],
			unit: "million-total-tokens",
			conditions: { videoInput },
			usd: videoInput ? "7.5" : "11",
			approximateCredits: videoInput ? "1500" : "2200",
			source: source(videoModel),
		})),
	],
	gaps: [
		{ model: imageModel, reason: "unpriced-image-options" },
		{ model: videoModel, reason: "token-usage-unknown" },
	],
};

test("publishes one ToAPIs feed and preserves the last good observation on invalid or stale input", () => {
	const sandbox = mkdtempSync(resolve(tmpdir(), "siluet-toapis-pricing-"));
	const remote = resolve(sandbox, "remote");
	const local = resolve(sandbox, "publisher");
	function git(cwd: string, ...args: string[]) {
		const result = Bun.spawnSync(["git", ...args], {
			cwd,
			env: { PATH: process.env.PATH, HOME: sandbox },
			stdout: "pipe",
			stderr: "pipe",
		});
		if (!result.success) throw new Error(result.stderr.toString());
		return result.stdout.toString().trimEnd();
	}
	function publish(value: unknown) {
		return Bun.spawnSync(["bash", script, "toapis"], {
			cwd: local,
			env: { PATH: process.env.PATH, HOME: sandbox },
			stdin: new TextEncoder().encode(JSON.stringify(value)),
			stdout: "pipe",
			stderr: "pipe",
		});
	}
	try {
		git(sandbox, "init", "--bare", remote);
		git(sandbox, "init", "--bare", local);
		git(local, "remote", "add", "origin", remote);

		const expired = publish({ ...observation, conversionCacheAgeSeconds: 30 * daySeconds });
		expect(expired.stderr.toString()).toMatch(/expired/i);
		expect(git(remote, "for-each-ref")).toBe("");

		const firstPublish = publish(observation);
		if (!firstPublish.success) throw new Error(firstPublish.stderr.toString());
		const first = git(remote, "rev-parse", ref);
		expect(git(remote, "for-each-ref", "--format=%(refname)")).toBe(ref);
		expect(git(remote, "ls-tree", "-r", "--name-only", ref)).toBe(feedPath);
		expect(JSON.parse(git(remote, "show", `${ref}:${feedPath}`))).toEqual(observation);

		expect(publish(observation).exitCode).toBe(0);
		expect(publish({ ...observation, observedAt: observed(4, "10:30:00") }).exitCode).toBe(0);
		expect(git(remote, "rev-parse", ref)).toBe(first);

		const next = { ...observation, observedAt: observed(3) };
		expect(publish(next).exitCode).toBe(0);
		const second = git(remote, "rev-parse", ref);
		expect(git(remote, "rev-parse", `${ref}^`)).toBe(first);
		expect(JSON.parse(git(remote, "show", `${ref}:${feedPath}`))).toEqual(next);

		const newer = { ...observation, observedAt: observed(2) };
		for (const [bad, reason] of [
			[
				{ ...newer, receiptDelaySeconds: { conversion: daySeconds + 1, image: 0, video: 0 } },
				/rollback/i,
			],
			[{ ...newer, conversionCacheAgeSeconds: daySeconds + 1 }, /rollback/i],
			[
				{
					...newer,
					rates: newer.rates.map((rate) =>
						rate.unit === "image"
							? { ...rate, source: { ...rate.source, cacheAgeSeconds: daySeconds + 1 } }
							: rate,
					),
				},
				/rollback/i,
			],
			[
				{
					...newer,
					rates: newer.rates.map((rate) => ({
						...rate,
						source: { ...rate.source, cacheAgeSeconds: 30 * daySeconds },
					})),
				},
				/expired/i,
			],
		] as const) {
			expect(publish(bad).stderr.toString()).toMatch(reason);
			expect(git(remote, "rev-parse", ref)).toBe(second);
		}
		const invalid = [
			observation,
			{ ...newer, provider: "poyo" },
			{ ...newer, rates: newer.rates.slice(1) },
			{ ...newer, rates: [...newer.rates.slice(1), newer.rates[1]] },
			{ ...newer, rates: newer.rates.map((rate) => ({ ...rate, usd: "0" })) },
			{ ...newer, rates: newer.rates.map((rate) => ({ ...rate, approximateCredits: "1" })) },
			{ ...newer, conversionCacheAgeSeconds: Number.MAX_SAFE_INTEGER },
			{ ...newer, gaps: [] },
			{ ...newer, observedAt: "2026-02-30T00:00:00Z" },
			{ ...newer, observedAt: "2099-01-01T00:00:00Z" },
		];
		for (const candidate of invalid) {
			expect(publish(candidate).success).toBe(false);
			expect(git(remote, "rev-parse", ref)).toBe(second);
		}
		expect(JSON.parse(git(remote, "show", `${ref}:${feedPath}`))).toEqual(next);
	} finally {
		rmSync(sandbox, { recursive: true, force: true });
	}
}, 30_000);

test("the TypeScript decoder and jq agree on ToAPIs observation and paired-rate validation", () => {
	const [first, second, ...other] = observation.rates;
	const rejected = [
		{ ...observation, receiptDelaySeconds: { conversion: 0, image: 1, video: 0 } },
		{ ...observation, receiptDelaySeconds: { conversion: 4, image: 2, video: -1 } },
		{ ...observation, receiptDelaySeconds: { conversion: 4, image: 2.5, video: 1 } },
		{ ...observation, receiptDelaySeconds: null },
		{ ...observation, observedAt: observation.observedAt.replace("Z", ".125Z") },
		{ ...observation, observedAt: observation.observedAt.replace("Z", "+00:00") },
		{
			...observation,
			rates: [first, { ...second, usd: "0.02", approximateCredits: "4" }, ...other],
		},
		{
			...observation,
			rates: [first, { ...second, source: { ...second.source, cacheAgeSeconds: 1 } }, ...other],
		},
		{
			...observation,
			rates: [
				first,
				second,
				...other.map((rate, index) =>
					index === 1 ? { ...rate, source: { ...rate.source, cacheAgeSeconds: 1 } } : rate,
				),
			],
		},
		{ ...observation, rates: [...observation.rates].reverse() },
	];
	const filter = resolve(import.meta.dir, "providers/toapis/publish.jq");
	for (const [feed, valid] of [
		[observation, true],
		[{ ...observation, receiptDelaySeconds: { conversion: 4, image: 2, video: 0 } }, true],
		...rejected.map((candidate) => [candidate, false] as const),
	] as const) {
		const output = Bun.spawnSync(["jq", "-RsceS", "-L", import.meta.dir, "-f", filter], {
			stdin: new TextEncoder().encode(JSON.stringify(feed)),
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(output.success).toBe(valid);
		expect(Boolean(decodeToapisPricingFeed(feed))).toBe(valid);
	}
});

test("missing page ages keep their positions during a source rollback check", () => {
	function snapshot(age: number, category: string, days: number) {
		return {
			...observation,
			observedAt: observed(days),
			rates: observation.rates.map((rate) => ({
				...rate,
				source: { ...rate.source, cacheAgeSeconds: rate.unit === category ? age : null },
			})),
		};
	}
	const previous = snapshot(2 * daySeconds, "image", 4);
	const next = snapshot(1.5 * daySeconds, "million-total-tokens", 3);
	const result = Bun.spawnSync([
		"jq",
		"-en",
		"--argjson",
		"candidate",
		JSON.stringify(next),
		"--argjson",
		"previous",
		JSON.stringify(previous),
		"--arg",
		"now",
		observed(0),
		"-f",
		resolve(import.meta.dir, "providers/toapis/freshness.jq"),
	]);
	expect(result.stderr.toString()).toContain("rollback");
});
