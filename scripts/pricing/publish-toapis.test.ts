import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { decodeToapisPricingFeed } from "../../src/lib/shared/pricing/toapis-feed";

const ref = "refs/heads/pricing-data-toapis";
const feedPath = "pricing/v2/toapis.json";
const v1Path = "pricing/v1/toapis.json";
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
const tiers = ["1K", "1.5K", "2K"].map((size) => ({
	model: imageModel,
	operations: ["generate", "edit"],
	unit: "image",
	conditions: { size, outputCount: 1, layerDecomposition: false },
	usd: "0.014125",
	approximateCredits: "2.825",
	source: source(imageModel),
}));
const reference = {
	model: imageModel,
	operations: ["generate", "edit"],
	unit: "reference-image",
	conditions: { freeAllowance: 0 },
	usd: "0.0056",
	approximateCredits: "1.12",
	source: source(imageModel),
};
const observation = {
	version: 2,
	provider: "toapis",
	observedAt: observed(4),
	creditsPerUsd: "200",
	conversionSourceUrl: "https://toapis.com/pricing",
	conversionCacheAgeSeconds: null,
	receiptDelaySeconds: { conversion: 0, image: 0, video: 0 },
	rates: [
		...tiers,
		reference,
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
// The frozen v1 shape: no reference rate and optional receipt delays.
const { receiptDelaySeconds: _delays, ...v1Fields } = observation;
const v1Observation = {
	...v1Fields,
	version: 1,
	rates: observation.rates.filter((rate) => rate.unit !== "reference-image"),
};

function sandboxGit(sandbox: string) {
	return function git(cwd: string, ...args: string[]) {
		const result = Bun.spawnSync(["git", ...args], {
			cwd,
			env: { PATH: process.env.PATH, HOME: sandbox },
			stdout: "pipe",
			stderr: "pipe",
		});
		if (!result.success) throw new Error(result.stderr.toString());
		return result.stdout.toString().trimEnd();
	};
}

function publisher(sandbox: string, local: string) {
	return function publish(value: unknown) {
		return Bun.spawnSync(["bash", script, "toapis"], {
			cwd: local,
			env: {
				PATH: process.env.PATH,
				HOME: sandbox,
				GITHUB_STEP_SUMMARY: resolve(sandbox, "summary.md"),
			},
			stdin: new TextEncoder().encode(JSON.stringify(value)),
			stdout: "pipe",
			stderr: "pipe",
		});
	};
}

test("publishes one ToAPIs feed and preserves the last good observation on invalid or stale input", () => {
	const sandbox = mkdtempSync(resolve(tmpdir(), "siluet-toapis-pricing-"));
	const remote = resolve(sandbox, "remote");
	const local = resolve(sandbox, "publisher");
	const git = sandboxGit(sandbox);
	const summary = resolve(sandbox, "summary.md");
	const publish = publisher(sandbox, local);
	try {
		git(sandbox, "init", "--bare", remote);
		git(sandbox, "init", "--bare", local);
		git(local, "remote", "add", "origin", remote);

		const expired = publish({ ...observation, conversionCacheAgeSeconds: 30 * daySeconds });
		expect(expired.stderr.toString()).toMatch(/expired/i);
		expect(git(remote, "for-each-ref")).toBe("");

		const firstPublish = publish(observation);
		if (!firstPublish.success) throw new Error(firstPublish.stderr.toString());
		expect(firstPublish.stdout.toString()).toContain(
			`::notice title=Pricing published::ToAPIs pricing published: observed ${observation.observedAt}.`,
		);
		expect(readFileSync(summary, "utf8")).toContain("ToAPIs pricing published");
		const first = git(remote, "rev-parse", ref);
		expect(git(remote, "for-each-ref", "--format=%(refname)")).toBe(ref);
		expect(git(remote, "ls-tree", "-r", "--name-only", ref)).toBe(feedPath);
		expect(JSON.parse(git(remote, "show", `${ref}:${feedPath}`))).toEqual(observation);

		expect(publish(observation).stdout.toString()).toContain("ToAPIs pricing is unchanged.");
		const sameDay = publish({ ...observation, observedAt: observed(4, "10:30:00") });
		expect(sameDay.exitCode).toBe(0);
		expect(sameDay.stdout.toString()).toContain(
			"::notice title=Pricing not published::ToAPIs pricing was already published today.",
		);
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
						rate.model === imageModel
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
			{ ...v1Observation, observedAt: newer.observedAt },
			{ ...newer, version: 1 },
			{ ...newer, rates: newer.rates.filter((rate) => rate.unit !== "reference-image") },
			{
				...newer,
				rates: newer.rates.map((rate) =>
					rate.unit === "reference-image" ? { ...rate, conditions: { freeAllowance: 1 } } : rate,
				),
			},
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
	const [one, oneAndHalf, two, image, ...video] = observation.rates;
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
		{ ...observation, receiptDelaySeconds: undefined },
		{ ...observation, rates: [one, oneAndHalf, two, ...video] },
		{ ...observation, rates: [one, oneAndHalf, two, ...video, image] },
		{ ...observation, rates: [one, oneAndHalf, two, { ...image, conditions: {} }, ...video] },
		{
			...observation,
			rates: [
				one,
				oneAndHalf,
				two,
				{ ...image, usd: "0.0064", approximateCredits: "1.2" },
				...video,
			],
		},
		{
			...observation,
			rates: [
				one,
				oneAndHalf,
				two,
				{ ...image, source: { ...image.source, cacheAgeSeconds: 2 } },
				...video,
			],
		},
	];
	const filter = resolve(import.meta.dir, "providers/toapis/publish-v2.jq");
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

function freshness(next: unknown, previous: unknown) {
	const sandbox = mkdtempSync(resolve(tmpdir(), "siluet-toapis-order-"));
	const files = {
		candidate: resolve(sandbox, "candidate.json"),
		previous: resolve(sandbox, "previous.json"),
	};
	writeFileSync(files.candidate, `${JSON.stringify(next)}\n`);
	writeFileSync(files.previous, `${JSON.stringify(previous)}\n`);
	const result = Bun.spawnSync([
		"jq",
		"-en",
		"--slurpfile",
		"candidate",
		files.candidate,
		"--slurpfile",
		"previous",
		files.previous,
		"--arg",
		"now",
		observed(0),
		"-f",
		resolve(import.meta.dir, "providers/toapis/freshness.jq"),
	]);
	rmSync(sandbox, { recursive: true, force: true });
	return result;
}

function aged(
	feed: typeof observation | typeof v1Observation,
	model: string,
	age: number,
	days: number,
) {
	return {
		...feed,
		observedAt: observed(days),
		rates: feed.rates.map((rate) => ({
			...rate,
			source: { ...rate.source, cacheAgeSeconds: rate.model === model ? age : null },
		})),
	};
}

test("missing page ages keep their keys during a source rollback check", () => {
	const previous = aged(observation, imageModel, 2 * daySeconds, 4);
	const next = aged(observation, videoModel, 1.5 * daySeconds, 3);
	expect(freshness(next, previous).stderr.toString()).toContain("rollback");
});

test("a v2 candidate is checked against a v1 predecessor on their shared observations", () => {
	const previous = aged(v1Observation, imageModel, 0, 4);
	expect(freshness(aged(observation, imageModel, 0, 3), previous).success).toBe(true);
	expect(
		freshness(aged(observation, imageModel, 2 * daySeconds, 3), previous).stderr.toString(),
	).toContain("rollback");
	expect(
		freshness(
			{ ...observation, observedAt: observed(3), conversionCacheAgeSeconds: 2 * daySeconds },
			previous,
		).stderr.toString(),
	).toContain("rollback");
	expect(
		freshness(aged(observation, videoModel, 2 * daySeconds, 3), previous).stderr.toString(),
	).toContain("rollback");
});

test("the frozen v1 validator still accepts only the v1 shape", () => {
	const filter = resolve(import.meta.dir, "providers/toapis/publish.jq");
	for (const [feed, valid] of [
		[v1Observation, true],
		[observation, false],
	] as const) {
		const output = Bun.spawnSync(["jq", "-RsceS", "-L", import.meta.dir, "-f", filter], {
			stdin: new TextEncoder().encode(JSON.stringify(feed)),
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(output.success).toBe(valid);
	}
});

test("the first v2 publish keeps the frozen v1 blob and refuses an older observation", () => {
	const sandbox = mkdtempSync(resolve(tmpdir(), "siluet-toapis-bootstrap-"));
	const remote = resolve(sandbox, "remote");
	const local = resolve(sandbox, "publisher");
	const git = sandboxGit(sandbox);
	const publish = publisher(sandbox, local);
	function seed(files: Record<string, unknown>) {
		const work = resolve(sandbox, "seed");
		git(sandbox, "init", "-q", work);
		for (const [path, value] of Object.entries(files)) {
			Bun.spawnSync(["mkdir", "-p", resolve(work, path, "..")]);
			writeFileSync(
				resolve(work, path),
				typeof value === "string" ? value : `${JSON.stringify(value)}\n`,
			);
		}
		git(work, "add", ".");
		git(
			work,
			"-c",
			"user.name=seed",
			"-c",
			"user.email=seed@example.invalid",
			"commit",
			"-qm",
			"seed",
		);
		git(work, "push", "-q", remote, `HEAD:${ref}`);
		rmSync(work, { recursive: true, force: true });
	}
	try {
		git(sandbox, "init", "--bare", remote);
		git(sandbox, "init", "--bare", local);
		git(local, "remote", "add", "origin", remote);
		const frozen = aged(v1Observation, imageModel, 3600, 4);
		seed({ [v1Path]: { ...frozen, observedAt: observed(4, "12:00:00") } });
		const seeded = git(remote, "rev-parse", ref);
		const v1Blob = git(remote, "rev-parse", `${ref}:${v1Path}`);

		for (const [bad, reason] of [
			[{ ...observation, observedAt: observed(4, "12:00:00") }, /newer observation/],
			[{ ...observation, observedAt: observed(4, "11:00:00") }, /newer observation|rollback/],
			[aged(observation, imageModel, 2 * daySeconds, 3), /rollback/],
			[
				{ ...observation, observedAt: observed(3), conversionCacheAgeSeconds: 2 * daySeconds },
				/rollback/,
			],
		] as const) {
			expect(publish(bad).stderr.toString()).toMatch(reason);
			expect(git(remote, "rev-parse", ref)).toBe(seeded);
		}

		// The same UTC day as the v1 observation still publishes the first v2 feed.
		const first = aged(observation, imageModel, 0, 4);
		const bootstrap = { ...first, observedAt: observed(4, "13:00:00") };
		const result = publish(bootstrap);
		if (!result.success) throw new Error(result.stderr.toString());
		expect(git(remote, "rev-parse", `${ref}^`)).toBe(seeded);
		expect(git(remote, "ls-tree", "-r", "--name-only", ref).split("\n")).toEqual([
			v1Path,
			feedPath,
		]);
		expect(git(remote, "rev-parse", `${ref}:${v1Path}`)).toBe(v1Blob);
		expect(JSON.parse(git(remote, "show", `${ref}:${feedPath}`))).toEqual(bootstrap);
		const published = git(remote, "rev-parse", ref);

		expect(publish(bootstrap).stdout.toString()).toContain("ToAPIs pricing is unchanged.");
		const sameDay = publish({ ...bootstrap, observedAt: observed(4, "14:00:00") });
		expect(sameDay.stdout.toString()).toContain("ToAPIs pricing was already published today.");
		const rollback = publish(aged(observation, imageModel, 3 * daySeconds, 3));
		expect(rollback.stderr.toString()).toMatch(/rollback/);
		expect(git(remote, "rev-parse", ref)).toBe(published);

		const next = { ...observation, observedAt: observed(3) };
		expect(publish(next).success).toBe(true);
		expect(git(remote, "rev-parse", `${ref}:${v1Path}`)).toBe(v1Blob);
		expect(JSON.parse(git(remote, "show", `${ref}:${feedPath}`))).toEqual(next);
	} finally {
		rmSync(sandbox, { recursive: true, force: true });
	}
}, 30_000);

test("refuses a ToAPIs data branch with foreign contents", () => {
	const sandbox = mkdtempSync(resolve(tmpdir(), "siluet-toapis-foreign-"));
	const remote = resolve(sandbox, "remote");
	const local = resolve(sandbox, "publisher");
	const git = sandboxGit(sandbox);
	const publish = publisher(sandbox, local);
	try {
		git(sandbox, "init", "--bare", remote);
		git(sandbox, "init", "--bare", local);
		git(local, "remote", "add", "origin", remote);
		const work = resolve(sandbox, "seed");
		git(sandbox, "init", "-q", work);
		Bun.spawnSync(["mkdir", "-p", resolve(work, "pricing/v1")]);
		writeFileSync(resolve(work, v1Path), `${JSON.stringify(v1Observation)}\n`);
		writeFileSync(resolve(work, "pricing/v1/notes.txt"), "extra\n");
		git(work, "add", ".");
		git(
			work,
			"-c",
			"user.name=seed",
			"-c",
			"user.email=seed@example.invalid",
			"commit",
			"-qm",
			"seed",
		);
		git(work, "push", "-q", remote, `HEAD:${ref}`);
		const seeded = git(remote, "rev-parse", ref);
		const result = publish({ ...observation, observedAt: observed(3) });
		expect(result.stderr.toString()).toContain("Unexpected contents");
		expect(git(remote, "rev-parse", ref)).toBe(seeded);
	} finally {
		rmSync(sandbox, { recursive: true, force: true });
	}
}, 30_000);
