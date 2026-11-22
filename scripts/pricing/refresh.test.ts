import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, rmdir, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { estimatePrice } from "../../src/lib/shared/pricing/estimate";
import type { PricingFeed } from "../../src/lib/shared/pricing/feed";
import h3Fixture from "../../tests/fixtures/h3-rate.v2.json";
import { poyoV2Feed, sizedPoyoV2Feed } from "../../tests/fixtures/poyo-v2-feed";
import { toapisRates } from "../../tests/fixtures/toapis-feed";
import { loadLocalPricing, pricingCachePath } from "./local-feed";
import {
	describeRefresh,
	encodeCacheEntry,
	poyoV2PricingFeedUrl,
	pricingFeedUrl,
	refreshPricingFeed,
	toapisPricingFeedUrl,
} from "./refresh";

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
let v2BundledPath: string;
let v2CachePath: string;

beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), "siluet-pricing-"));
	bundledPath = join(directory, "bundled.json");
	cachePath = join(directory, "local", "feed.json");
	// The v1 tests run without a bundled v2 feed, as before v2 publication.
	v2BundledPath = join(directory, "bundled-v2.json");
	v2CachePath = join(directory, "local-v2", "poyo.json");
	await writeFile(bundledPath, JSON.stringify(initial));
});

afterEach(async () => {
	await rm(directory, { recursive: true, force: true });
});

function poyoPaths() {
	return { bundledPath, cachePath, v2BundledPath, v2CachePath };
}

function refresh(
	fetchFeed: (url: string, init: RequestInit) => Promise<Response>,
	timeoutMs?: number,
) {
	return refreshPricingFeed({ ...poyoPaths(), fetchFeed, now: () => nowMs, timeoutMs });
}

/** Serve the v1 feed from `reply` while the v2 feed is not yet published. */
function v1Only(reply: (url: string, init: RequestInit) => Promise<Response>) {
	return async (url: string, init: RequestInit) =>
		url === poyoV2PricingFeedUrl
			? new Response("404: Not Found", { status: 404 })
			: reply(url, init);
}

function jsonResponse(value: unknown) {
	return v1Only(async () => Response.json(value));
}

describe("opt-in pricing refresh", () => {
	test("checks the exact public URL once and writes the validated feed beside its check time", async () => {
		const requests: { url: string; init: RequestInit }[] = [];
		const result = await refresh(async (url, init) => {
			requests.push({ url, init });
			return jsonResponse(newer)(url, init);
		});
		expect(requests.map(({ url }) => url)).toEqual([poyoV2PricingFeedUrl, pricingFeedUrl]);
		expect(requests[1]).toMatchObject({
			url: "https://raw.githubusercontent.com/edbfi/siluet/pricing-data/pricing/v1/feed.json",
			init: { method: "GET", redirect: "error", credentials: "omit" },
		});
		expect(requests[0].init).toMatchObject({
			method: "GET",
			redirect: "error",
			credentials: "omit",
		});
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
					...poyoPaths(),
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
			...poyoPaths(),
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
		const selected = await loadLocalPricing(nowMs, poyoPaths());
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
			...poyoPaths(),
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
			refresh(
				v1Only(
					async () => new Response("x", { headers: { "content-length": String(128 * 1024) } }),
				),
			),
		).rejects.toThrow(/size/i);
		await expect(
			refresh(
				v1Only(
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
		expect(await loadLocalPricing(nowMs, poyoPaths())).toEqual(newer);
		await expect(refresh(jsonResponse(newer))).rejects.toThrow(/locked.*rmdir.*empty/i);
		expect(await loadLocalPricing(nowMs, poyoPaths())).toEqual(newer);
		await rmdir(lock);
		expect(await refresh(jsonResponse(newer))).toMatchObject({ status: "unchanged" });
		expect(await loadLocalPricing(nowMs, poyoPaths())).toEqual(newer);
	});

	test("leaves the newer revision when an older refresh response finishes later", async () => {
		const { promise, resolve } = Promise.withResolvers<Response>();
		const pending = refresh(v1Only(() => promise));
		await refresh(jsonResponse(newer));
		resolve(Response.json(initial));
		await expect(pending).rejects.toThrow(/rollback/i);
		expect(await loadLocalPricing(nowMs, poyoPaths())).toEqual(newer);
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
		const paths = poyoPaths();
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
		expect(await loadLocalPricing(later, poyoPaths())).toEqual(initial);
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
		expect(await loadLocalPricing(nowMs, poyoPaths())).toEqual(initial);
		await expect(refresh(jsonResponse(unavailable))).rejects.toThrow(/conflict/i);
		expect(await loadLocalPricing(nowMs, poyoPaths())).toEqual(initial);
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
		expect(await loadLocalPricing(nowMs, poyoPaths())).toEqual(newer);
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

describe("confirmed PoYo v2 refresh", () => {
	const v2Now = Date.parse("2026-11-25T00:00:00Z");
	const v2CheckedAt = new Date(v2Now).toISOString();
	const bundledV2 = { ...poyoV2Feed, confirmedAt: poyoV2Feed.sourceDate };
	const confirmed = { ...poyoV2Feed, confirmedAt: "2026-11-24T13:30:00Z" };

	beforeEach(async () => {
		await writeFile(v2BundledPath, JSON.stringify(bundledV2));
	});

	function refreshV2(reply: unknown, at = v2Now) {
		const requests: string[] = [];
		const result = refreshPricingFeed({
			...poyoPaths(),
			now: () => at,
			async fetchFeed(url, init) {
				requests.push(url);
				expect(init).toMatchObject({ method: "GET", redirect: "error", credentials: "omit" });
				return reply instanceof Response ? reply : Response.json(reply);
			},
		});
		return { result, requests };
	}

	test("fetches the published v2 feed and caches it compactly beside v1", async () => {
		const { result, requests } = refreshV2(confirmed);
		expect(await result).toEqual({
			status: "updated",
			checkedAt: v2CheckedAt,
			feed: confirmed,
			cachePath: v2CachePath,
		});
		expect(requests).toEqual([
			"https://raw.githubusercontent.com/edbfi/siluet/pricing-data/pricing/v2/poyo.json",
		]);
		const saved = await readFile(v2CachePath, "utf8");
		expect(saved).toBe(`${JSON.stringify({ checkedAt: v2CheckedAt, feed: confirmed })}\n`);
		expect(await Bun.file(cachePath).exists()).toBe(false);
		expect(await loadLocalPricing(v2Now, poyoPaths())).toEqual(confirmed);
	});

	test("reports a published feed in sorted key order as unchanged", async () => {
		const sorted = (value: unknown): unknown =>
			value && typeof value === "object"
				? Object.fromEntries(
						Object.entries(value)
							.sort(([a], [b]) => (a < b ? -1 : 1))
							.map(([key, field]) => [key, sorted(field)]),
					)
				: value;
		const published = sorted(bundledV2);
		expect(JSON.stringify(published)).not.toBe(JSON.stringify(bundledV2));
		expect(await refreshV2(published).result).toMatchObject({
			status: "unchanged",
			feed: bundledV2,
		});
	});

	test("falls back to the v1 feed only when the v2 feed is not found", async () => {
		const { result } = refreshV2(new Response("error", { status: 503 }));
		await expect(result).rejects.toThrow(/HTTP 503/);
		expect(await refresh(jsonResponse(newer))).toMatchObject({ cachePath, feed: newer });
		expect(await Bun.file(v2CachePath).exists()).toBe(false);
	});

	test.each([
		{
			name: "30 days old",
			feed: { ...poyoV2Feed, confirmedAt: "2026-11-25T00:00:00Z" },
			at: Date.parse("2026-12-25T00:00:00Z"),
			reason: /expired/i,
		},
		{
			name: "dated after the clock",
			feed: { ...poyoV2Feed, confirmedAt: "2026-11-25T00:00:01Z" },
			at: v2Now,
			reason: /future/i,
		},
	])("rejects a confirmation $name before writing", async ({ feed, at, reason }) => {
		await refreshV2(confirmed).result;
		const saved = await readFile(v2CachePath, "utf8");
		await expect(refreshV2(feed, at).result).rejects.toThrow(reason);
		expect(await readFile(v2CachePath, "utf8")).toBe(saved);
	});

	test("rejects an older confirmation of the cached revision", async () => {
		await refreshV2(confirmed).result;
		const saved = await readFile(v2CachePath, "utf8");
		await expect(refreshV2(poyoV2Feed).result).rejects.toThrow(/rollback/i);
		expect(await readFile(v2CachePath, "utf8")).toBe(saved);
	});

	test("keeps a cache confirmed after the clock when the device clock steps back", async () => {
		await refreshV2(confirmed).result;
		const saved = await readFile(v2CachePath, "utf8");
		const steppedBack = Date.parse("2026-11-24T00:00:00Z");
		await expect(refreshV2(poyoV2Feed, steppedBack).result).rejects.toThrow(/future/i);
		expect(await readFile(v2CachePath, "utf8")).toBe(saved);
	});

	test.each([1, 4])(
		"refreshes a 64 KiB feed nested %i deep and rejects one byte more",
		async (depth) => {
			const largest = sizedPoyoV2Feed(64 * 1024, { depth });
			const body = `${JSON.stringify(largest)}\n`;
			expect(new TextEncoder().encode(body).byteLength).toBe(65_536);
			await expect(refreshV2(new Response(body)).result).resolves.toMatchObject({
				status: "updated",
			});
			expect((await readFile(v2CachePath)).byteLength).toBeLessThan(256 * 1024);
			expect<unknown>(await loadLocalPricing(v2Now, poyoPaths())).toEqual(largest);
			const saved = await readFile(v2CachePath, "utf8");
			const over = `${JSON.stringify(sizedPoyoV2Feed(64 * 1024 + 1, { depth }))}\n`;
			await expect(refreshV2(new Response(over)).result).rejects.toThrow(/size/i);
			await expect(
				refreshV2(new Response("x", { headers: { "content-length": "65537" } })).result,
			).rejects.toThrow(/size/i);
			expect(await readFile(v2CachePath, "utf8")).toBe(saved);
		},
	);

	test("refuses to serialise a cache entry the reader would reject", () => {
		const entry = { checkedAt: v2CheckedAt, feed: confirmed };
		expect(encodeCacheEntry("poyo-v2", entry)).toEndWith("}\n");
		const huge = { ...confirmed, revision: "x".repeat(256 * 1024) };
		expect(() => encodeCacheEntry("poyo-v2", { ...entry, feed: huge })).toThrow(/size/i);
	});

	test("keeps an unfamiliar rate through refresh, cache and reread", async () => {
		await writeFile(
			v2BundledPath,
			JSON.stringify({ ...h3Fixture, confirmedAt: h3Fixture.sourceDate }),
		);
		const result = await refreshV2(h3Fixture).result;
		expect(result).toMatchObject({ status: "updated" });
		expect(JSON.parse(await readFile(v2CachePath, "utf8")).feed).toEqual(h3Fixture);
		expect<unknown>(await loadLocalPricing(v2Now, poyoPaths())).toEqual(h3Fixture);
	});

	test("reports the source, confirmation and expiry", async () => {
		const result = await refreshV2(confirmed).result;
		expect(describeRefresh(result)).toBe(
			`Pricing updated at ${v2CheckedAt}. Source 2026-11-19T13:42:30Z (${confirmed.revision}). Confirmed 2026-11-24T13:30:00Z. Rates expire 2026-12-24T13:30:00.000Z.`,
		);
		expect(describeRefresh({ ...result, feed: initial })).toBe(
			`Pricing updated at ${v2CheckedAt}. Source ${initial.sourceDate} (${initial.revision}). Rates expire 2026-12-19T00:00:00.000Z.`,
		);
	});
});
