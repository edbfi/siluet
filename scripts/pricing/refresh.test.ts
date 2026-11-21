import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, rmdir, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { estimatePrice } from "../../src/lib/shared/pricing/estimate";
import type { PricingFeed } from "../../src/lib/shared/pricing/feed";
import { toapisRates } from "../../tests/fixtures/toapis-feed";
import { loadLocalPricing, pricingCachePath } from "./local-feed";
import { pricingFeedUrl, refreshPricingFeed, toapisPricingFeedUrl } from "./refresh";

const initial: PricingFeed = {
	version: 1,
	provider: "poyo",
	revision: "a".repeat(40),
	sourceDate: "2026-11-19T00:00:00Z",
	rates: {
		"z-image": { kind: "per-request", credits: "2.5" },
		"seedream-5.5": {
			kind: "per-image-with-references",
			resolutions: { "1K": "4", "1.5K": "4", "2K": "7" },
			perReference: "1.6",
		},
	},
};
const newer: PricingFeed = {
	...initial,
	revision: "b".repeat(40),
	sourceDate: "2026-11-20T00:00:00Z",
	rates: { ...initial.rates, "z-image": { kind: "unavailable" } },
};
const checkedAt = "2026-11-21T15:00:00.000Z";
const nowMs = Date.parse(checkedAt);
let directory: string;
let bundledPath: string;
let cachePath: string;

beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), "siluet-pricing-"));
	bundledPath = join(directory, "bundled.json");
	cachePath = join(directory, "local", "feed.json");
	await writeFile(bundledPath, JSON.stringify(initial));
});

afterEach(async () => {
	await rm(directory, { recursive: true, force: true });
});

function refresh(
	fetchFeed: (url: string, init: RequestInit) => Promise<Response>,
	timeoutMs?: number,
) {
	return refreshPricingFeed({ bundledPath, cachePath, fetchFeed, now: () => nowMs, timeoutMs });
}

function jsonResponse(value: unknown) {
	return async () => Response.json(value);
}

describe("opt-in pricing refresh", () => {
	test("checks the exact public URL once and writes the validated feed beside its check time", async () => {
		const requests: { url: string; init: RequestInit }[] = [];
		const result = await refresh(async (url, init) => {
			requests.push({ url, init });
			return Response.json(newer);
		});
		expect(requests).toHaveLength(1);
		expect(requests[0]).toMatchObject({
			url: "https://raw.githubusercontent.com/edbfi/siluet/pricing-data/pricing/v1/feed.json",
			init: { method: "GET", redirect: "error", credentials: "omit" },
		});
		expect(pricingFeedUrl).toBe(requests[0].url);
		expect(result).toEqual({ status: "updated", checkedAt, feed: newer, cachePath });
		expect(JSON.parse(await readFile(cachePath, "utf8"))).toEqual({ checkedAt, feed: newer });
		expect(await readFile(bundledPath, "utf8")).toBe(JSON.stringify(initial));
		expect(await readdir(join(directory, "local"))).toEqual(["feed.json"]);
	});

	test("refuses a cache path that resolves to the bundled feed", async () => {
		const alias = join(directory, "alias");
		await symlink(directory, alias, "junction");
		for (const collidingPath of [bundledPath, join(alias, "bundled.json")]) {
			await expect(
				refreshPricingFeed({
					bundledPath,
					cachePath: collidingPath,
					fetchFeed: jsonResponse(newer),
					now: () => nowMs,
				}),
			).rejects.toThrow(/separate/i);
			expect(await readFile(bundledPath, "utf8")).toBe(JSON.stringify(initial));
		}
	});

	test("bootstraps an empty cache and refuses to overwrite an invalid cache without a baseline", async () => {
		await rm(bundledPath);
		await mkdir(join(directory, "local"));
		await writeFile(cachePath, "bad json");
		await expect(refresh(jsonResponse(newer))).rejects.toThrow(/invalid/i);
		expect(await readFile(cachePath, "utf8")).toBe("bad json");
		await rm(cachePath);
		expect(await refresh(jsonResponse(newer))).toMatchObject({ status: "updated", feed: newer });
	});

	test("preserves a source dated after the current clock", async () => {
		await refreshPricingFeed({
			bundledPath,
			cachePath,
			fetchFeed: jsonResponse({
				...newer,
				revision: "c".repeat(40),
				sourceDate: "2026-11-22T00:00:00Z",
			}),
			now: () => Date.parse("2026-11-22T00:00:00Z"),
		});
		const saved = await readFile(cachePath, "utf8");
		await expect(refresh(jsonResponse(newer))).rejects.toThrow(/future/i);
		expect(await readFile(cachePath, "utf8")).toBe(saved);
		const selected = await loadLocalPricing(nowMs, { bundledPath, cachePath });
		expect(
			estimatePrice(
				selected,
				{
					provider: "poyo",
					model: "z-image",
					operation: "generate",
					options: { size: "1:1" },
					sourceCount: 0,
					count: 1,
					retryLimit: 0,
				},
				nowMs,
			),
		).toMatchObject({ reason: "invalid-clock" });
	});

	test("records an unchanged check without moving the source date", async () => {
		await refresh(jsonResponse(newer));
		const nextCheckedAt = "2026-11-22T00:00:00.000Z";
		const result = await refreshPricingFeed({
			bundledPath,
			cachePath,
			fetchFeed: jsonResponse(newer),
			now: () => Date.parse(nextCheckedAt),
		});
		expect(result).toMatchObject({ status: "unchanged", checkedAt: nextCheckedAt, feed: newer });
		expect(JSON.parse(await readFile(cachePath, "utf8"))).toEqual({
			checkedAt: nextCheckedAt,
			feed: newer,
		});
	});

	test.each([
		{ name: "older feed", candidate: initial },
		{
			name: "different revision with the same date",
			candidate: { ...newer, revision: "c".repeat(40) },
		},
		{
			name: "changed rates on the same revision",
			candidate: { ...newer, rates: { ...newer.rates, "seedream-5.5": { kind: "unavailable" } } },
		},
		{
			name: "new date on a previously seen revision",
			candidate: { ...initial, sourceDate: checkedAt },
		},
	])("preserves the cache on rollback or revision conflict from $name", async ({ candidate }) => {
		await refresh(jsonResponse(newer));
		const saved = await readFile(cachePath, "utf8");
		await expect(refresh(jsonResponse(candidate))).rejects.toThrow(/rollback|conflict/i);
		expect(await readFile(cachePath, "utf8")).toBe(saved);
		expect(await readdir(join(directory, "local"))).toEqual(["feed.json"]);
	});

	test("rejects stale and future source dates before touching the cache", async () => {
		await refresh(jsonResponse(newer));
		const saved = await readFile(cachePath, "utf8");
		await expect(
			refresh(jsonResponse({ ...newer, sourceDate: "2026-11-22T00:00:00Z" })),
		).rejects.toThrow(/future/i);
		await expect(
			refresh(jsonResponse({ ...newer, sourceDate: "2026-10-22T15:00:00Z" })),
		).rejects.toThrow(/expired/i);
		expect(await readFile(cachePath, "utf8")).toBe(saved);
	});

	test("keeps the last good feed when the server fails, redirects, or returns invalid data", async () => {
		await refresh(jsonResponse(newer));
		const saved = await readFile(cachePath, "utf8");
		for (const reply of [
			async () => new Response("error", { status: 503 }),
			async () => Response.redirect("https://example.test/feed.json"),
			async () => new Response("{"),
			jsonResponse({ ...newer, rates: {} }),
		]) {
			await expect(refresh(reply)).rejects.toThrow();
			expect(await readFile(cachePath, "utf8")).toBe(saved);
		}
	});

	test("bounds declared and streamed bytes", async () => {
		await expect(
			refresh(async () => new Response("x", { headers: { "content-length": String(128 * 1024) } })),
		).rejects.toThrow(/size/i);
		await expect(
			refresh(
				async () =>
					new Response(
						new ReadableStream<Uint8Array>({
							start(controller) {
								for (let index = 0; index < 32; index++) controller.enqueue(new Uint8Array(1024));
								controller.close();
							},
						}),
					),
			),
		).rejects.toThrow(/size/i);
		expect(await Bun.file(cachePath).exists()).toBe(false);
	});

	test("bounds a response that never completes its body", async () => {
		let cancelled = false;
		await expect(
			refresh(
				async () =>
					new Response(
						new ReadableStream<Uint8Array>({
							cancel() {
								cancelled = true;
							},
						}),
					),
				10,
			),
		).rejects.toThrow(/tim/i);
		expect(cancelled).toBe(true);
		expect(await Bun.file(cachePath).exists()).toBe(false);
	});

	test("keeps the last good cache readable after an interrupted write and permits a retry", async () => {
		await refresh(jsonResponse(newer));
		const lock = `${cachePath}.lock`;
		await mkdir(lock);
		await writeFile(join(directory, "local", ".feed-interrupted.tmp"), "partial");
		expect(await loadLocalPricing(nowMs, { cachePath, bundledPath })).toEqual(newer);
		await expect(refresh(jsonResponse(newer))).rejects.toThrow(/locked.*rmdir.*empty/i);
		expect(await loadLocalPricing(nowMs, { cachePath, bundledPath })).toEqual(newer);
		await rmdir(lock);
		expect(await refresh(jsonResponse(newer))).toMatchObject({ status: "unchanged" });
		expect(await loadLocalPricing(nowMs, { cachePath, bundledPath })).toEqual(newer);
	});

	test("leaves the newer revision when an older refresh response finishes later", async () => {
		const { promise, resolve } = Promise.withResolvers<Response>();
		const pending = refresh(() => promise);
		await refresh(jsonResponse(newer));
		resolve(Response.json(initial));
		await expect(pending).rejects.toThrow(/rollback/i);
		expect(await loadLocalPricing(nowMs, { cachePath, bundledPath })).toEqual(newer);
	});
});

describe("offline local pricing selection", () => {
	test("resolves cache locations outside the checkout", () => {
		expect(pricingCachePath("/custom/cache")).toBe("/custom/cache/siluet/pricing/v1/feed.json");
		expect(pricingCachePath("relative")).toBe(
			join(homedir(), ".cache", "siluet", "pricing", "v1", "feed.json"),
		);
	});

	test("prefers the newer cache, falls back to bundled on malformed or rolled-back cache", async () => {
		const paths = { cachePath, bundledPath };
		expect(await loadLocalPricing(nowMs, paths)).toEqual(initial);
		await refresh(jsonResponse(newer));
		expect(await loadLocalPricing(nowMs, paths)).toEqual(newer);
		for (const invalid of [
			"bad json",
			JSON.stringify({ checkedAt, feed: { ...newer, sourceDate: "2026-11-21T16:00:00Z" } }),
			JSON.stringify({ checkedAt: "2026-11-18T00:00:00Z", feed: newer }),
			JSON.stringify({ checkedAt, feed: { ...newer, sourceDate: "2026-11-18T00:00:00Z" } }),
			JSON.stringify({ checkedAt, feed: { ...newer, sourceDate: initial.sourceDate } }),
			JSON.stringify({ checkedAt, feed: { ...newer, revision: initial.revision } }),
		]) {
			await writeFile(cachePath, invalid);
			expect(await loadLocalPricing(nowMs, paths)).toEqual(initial);
		}
	});

	test("keeps expired feed provenance readable offline", async () => {
		const later = Date.parse("2026-12-21T00:00:00Z");
		expect(await loadLocalPricing(later, { cachePath, bundledPath })).toEqual(initial);
	});
});

describe("PoYo client recovery", () => {
	const unavailable: PricingFeed = {
		...initial,
		rates: { ...initial.rates, "z-image": { kind: "unavailable" } },
	};

	test("accepts a recovered model on the same revision and keeps it against a downgrade", async () => {
		await writeFile(bundledPath, JSON.stringify(unavailable));
		expect(await refresh(jsonResponse(initial))).toMatchObject({ status: "updated" });
		expect(await loadLocalPricing(nowMs, { cachePath, bundledPath })).toEqual(initial);
		await expect(refresh(jsonResponse(unavailable))).rejects.toThrow(/conflict/i);
		expect(await loadLocalPricing(nowMs, { cachePath, bundledPath })).toEqual(initial);
	});

	test("rejects a same-revision recovery that also changes a known model", async () => {
		await writeFile(bundledPath, JSON.stringify(unavailable));
		await expect(
			refresh(
				jsonResponse({
					...initial,
					rates: { ...initial.rates, "seedream-5.5": { kind: "unavailable" } },
				}),
			),
		).rejects.toThrow(/conflict/i);
	});

	test("keeps the source revision as the rollback floor after correcting the device clock", async () => {
		await mkdir(join(directory, "local"));
		await writeFile(cachePath, JSON.stringify({ checkedAt: "2026-11-30T00:00:00Z", feed: newer }));
		expect(await loadLocalPricing(nowMs, { cachePath, bundledPath })).toEqual(newer);
		await expect(refresh(jsonResponse(initial))).rejects.toThrow(/rollback/i);
		expect(await refresh(jsonResponse(newer))).toMatchObject({ status: "unchanged", checkedAt });
	});
});

describe("ToAPIs advertised pricing refresh", () => {
	test("uses its own public URL and cache and preserves the last good observation", async () => {
		const provider = "toapis";
		const publicBundle = join(directory, "bundled-toapis.json");
		const publicCache = pricingCachePath(join(directory, "cache-home"), provider);
		await writeFile(publicBundle, JSON.stringify(toapisRates));
		const paths = { provider, bundledPath: publicBundle, cachePath: publicCache } as const;
		const observation = { ...toapisRates, observedAt: "2026-11-21T10:00:00Z" };
		const result = await refreshPricingFeed({
			...paths,
			now: () => nowMs,
			async fetchFeed(url, init) {
				expect(url).toBe(toapisPricingFeedUrl);
				expect(init).toMatchObject({ method: "GET", redirect: "error", credentials: "omit" });
				expect(init.headers).toBeUndefined();
				return Response.json(observation);
			},
		});
		expect(result).toMatchObject({
			status: "updated",
			checkedAt,
			feed: { observedAt: observation.observedAt },
		});
		const saved = await readFile(publicCache, "utf8");
		for (const [bad, reason] of [
			[toapisRates, /rollback/i],
			[{ ...observation, conversionCacheAgeSeconds: 10 }, /conflict/i],
			[
				{
					...observation,
					observedAt: "2026-11-21T11:00:00Z",
					conversionCacheAgeSeconds: 30 * 86400,
				},
				/expired/i,
			],
			[initial, /schema/i],
		] as const) {
			await expect(
				refreshPricingFeed({
					...paths,
					fetchFeed: jsonResponse(bad),
					now: () => nowMs,
				}),
			).rejects.toThrow(reason);
			expect(await readFile(publicCache, "utf8")).toBe(saved);
		}
		expect(await loadLocalPricing(nowMs, paths)).toEqual(result.feed);
		expect(await Bun.file(cachePath).exists()).toBe(false);
	});
});

test("rejects newer ToAPIs wrappers over older model or conversion evidence", async () => {
	const provider = "toapis";
	const paths = { provider, bundledPath, cachePath } as const;
	await writeFile(bundledPath, JSON.stringify(toapisRates));
	const latest = {
		...toapisRates,
		observedAt: "2026-11-21T10:00:00Z",
		conversionCacheAgeSeconds: 30,
	};
	await refreshPricingFeed({
		...paths,
		now: () => nowMs,
		fetchFeed: jsonResponse(latest),
	});
	const saved = await readFile(cachePath, "utf8");
	const later = { ...latest, observedAt: "2026-11-21T11:00:00Z" };
	for (const feed of [
		{ ...later, conversionCacheAgeSeconds: 3631 },
		{
			...later,
			rates: later.rates.map((rate) =>
				rate.unit === "image"
					? { ...rate, source: { ...rate.source, cacheAgeSeconds: 3601 } }
					: rate,
			),
		},
	]) {
		await expect(
			refreshPricingFeed({ ...paths, now: () => nowMs, fetchFeed: jsonResponse(feed) }),
		).rejects.toThrow(/rollback/i);
		expect(await readFile(cachePath, "utf8")).toBe(saved);
	}
	const rolledBackPastBundle = { ...later, conversionCacheAgeSeconds: 24 * 3600 };
	await writeFile(cachePath, JSON.stringify({ checkedAt, feed: rolledBackPastBundle }));
	expect(await loadLocalPricing(nowMs, paths)).toMatchObject({
		provider,
		observedAt: toapisRates.observedAt,
	});
	expect(
		await refreshPricingFeed({
			...paths,
			now: () => nowMs,
			fetchFeed: jsonResponse({ ...latest, observedAt: "2026-11-21T12:00:00Z" }),
		}),
	).toMatchObject({ status: "updated", feed: { observedAt: "2026-11-21T12:00:00Z" } });
});
