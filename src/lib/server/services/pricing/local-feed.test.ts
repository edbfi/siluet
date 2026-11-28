import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import poyoFeed from "../../../../../pricing/v1/feed.json";
import poyoV2Bundle from "../../../../../pricing/v2/poyo.json";
import toapisFeed from "../../../../../pricing/v2/toapis.json";
import h3Fixture from "../../../../../tests/fixtures/h3-rate.v2.json";
import pair from "../../../../../tests/fixtures/poyo-basis-pair.json";
import { queueRows } from "../../../shared/media-catalog/image-queue";
import { estimateDerivedPrice } from "../../../shared/pricing/derived-estimate";
import { estimatePrice } from "../../../shared/pricing/estimate";
import { decodePoyoBasis } from "../../../shared/pricing/poyo-basis";
import { decodePoyoV2Feed } from "../../../shared/pricing/poyo-feed";
import {
	loadLocalPoyoPricing,
	poyoBasisPairs,
	poyoBasisPath,
	poyoFeedSha256,
	pricingCachePath,
	pricingFeedConflict,
} from "./local-feed";
import { loadStudioPricingFeeds } from "./studio-feeds";

const day = 24 * 60 * 60 * 1000;
let directory: string;

beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), "siluet-review-prices-"));
});

afterEach(async () => {
	await rm(directory, { recursive: true, force: true });
});

async function writeCache(path: string, value: unknown) {
	await mkdir(dirname(path), { recursive: true });
	await Bun.write(path, typeof value === "string" ? value : JSON.stringify(value));
}

function iso(ms: number) {
	return new Date(ms).toISOString().replace(".000Z", "Z");
}

test("Studio resolves each provider from embedded pricing and a valid newer local cache", async () => {
	// A cache replaces the bundle only when its source is newer than the bundled v2 feed.
	const sourceTime = Math.max(Date.parse(poyoFeed.sourceDate), Date.parse(poyoV2Bundle.sourceDate));
	const now = sourceTime + 2 * day;
	const check = new Date(now).toISOString();
	const candidate = {
		...poyoFeed,
		revision: (poyoFeed.revision[0] === "a" ? "b" : "a").repeat(40),
		sourceDate: new Date(sourceTime + day).toISOString(),
	};
	// Older than the bundled v1 feed, so the v1 cache is rejected as a rollback.
	const rollback = {
		...candidate,
		sourceDate: new Date(Date.parse(poyoFeed.sourceDate) - day).toISOString(),
	};
	const path = pricingCachePath(directory, "poyo");
	expect<unknown>(await loadStudioPricingFeeds(now, directory)).toEqual({
		poyo: poyoV2Bundle,
		toapis: toapisFeed,
	});
	await writeCache(path, { checkedAt: check, feed: candidate });
	expect<unknown>(await loadStudioPricingFeeds(now, directory)).toEqual({
		poyo: candidate,
		toapis: toapisFeed,
	});
	for (const invalid of [{ checkedAt: check, feed: rollback }, "not json"]) {
		await writeCache(path, invalid);
		expect<unknown>(await loadStudioPricingFeeds(now, directory)).toEqual({
			poyo: poyoV2Bundle,
			toapis: toapisFeed,
		});
	}
});

test("ToAPIs rates live under pricing/v2, and a v1 ToAPIs cache is never read", async () => {
	expect(pricingCachePath("/custom/cache", "toapis")).toBe(
		"/custom/cache/siluet/pricing/v2/toapis.json",
	);
	const observed = Date.parse(toapisFeed.observedAt);
	const now = observed + 2 * day;
	const checkedAt = new Date(now).toISOString();
	// An installation upgraded from v1 still holds a newer v1 ToAPIs cache.
	const { receiptDelaySeconds: _delays, ...v1Fields } = toapisFeed;
	const v1 = {
		...v1Fields,
		version: 1,
		observedAt: iso(observed + day),
		rates: toapisFeed.rates.filter((rate) => rate.unit !== "reference-image"),
	};
	await writeCache(join(directory, "siluet", "pricing", "v1", "toapis.json"), {
		checkedAt,
		feed: v1,
	});
	expect<unknown>((await loadStudioPricingFeeds(now, directory)).toapis).toEqual(toapisFeed);
	await writeCache(pricingCachePath(directory, "toapis"), { checkedAt, feed: v1 });
	expect<unknown>((await loadStudioPricingFeeds(now, directory)).toapis).toEqual(toapisFeed);
});

describe("confirmed PoYo v2 cache", () => {
	const bundled = decodePoyoV2Feed(poyoV2Bundle);
	if (!bundled) throw new Error("Invalid bundled v2 feed");
	const confirmed = Date.parse(bundled.confirmedAt);
	const later = { ...bundled, confirmedAt: iso(confirmed + 3 * day) };
	const now = confirmed + 4 * day;
	const checkedAt = new Date(now).toISOString();
	const studio = () => loadStudioPricingFeeds(now, directory).then(({ poyo }) => poyo);
	const v2Path = () => pricingCachePath(directory, "poyo-v2");

	test("lives beside the v1 cache under pricing/v2", () => {
		expect(pricingCachePath("/custom/cache", "poyo-v2")).toBe(
			"/custom/cache/siluet/pricing/v2/poyo.json",
		);
	});

	test("selects a later confirmation of the bundled revision", async () => {
		await writeCache(v2Path(), { checkedAt, feed: later });
		expect<unknown>(await studio()).toEqual(later);
	});

	test("rejects a cache confirmed after its check", async () => {
		await writeCache(v2Path(), { checkedAt: iso(confirmed + 2 * day), feed: later });
		expect<unknown>(await studio()).toEqual(bundled);
	});

	test("rejects a cache confirmed before the bundle", async () => {
		const older = { ...bundled, confirmedAt: bundled.sourceDate };
		const newerBundle = { ...bundled, confirmedAt: iso(confirmed + day) };
		expect(pricingFeedConflict(older, newerBundle)).toBe("rollback");
		expect(
			pricingFeedConflict(
				{ ...later, revision: "c".repeat(40), sourceDate: iso(confirmed + day) },
				{ ...later, confirmedAt: iso(confirmed + 4 * day) },
			),
		).toBe("rollback");
	});

	test("rejects a removed key or a changed unfamiliar rate at the same revision", () => {
		const current = decodePoyoV2Feed(h3Fixture);
		if (!current) throw new Error("Invalid H3 fixture");
		const { "h3-max": _, ...withoutH3 } = current.rates;
		const changed = {
			...current.rates,
			"h3-max": { kind: "per-second-by-resolution", resolutions: { "480p": "11", "768p": "16" } },
		};
		expect(pricingFeedConflict({ ...current, rates: withoutH3 }, current)).toBe(
			"revision conflict",
		);
		expect(pricingFeedConflict({ ...current, rates: changed }, current)).toBe("revision conflict");
		expect(
			pricingFeedConflict(
				{ ...current, rates: { ...current.rates, extra: { kind: "unavailable" } } },
				current,
			),
		).toBeUndefined();
		const recovered = { ...current.rates, "h3-max": { kind: "unavailable" } } as const;
		expect(pricingFeedConflict(current, { ...current, rates: recovered })).toBeUndefined();
	});

	test("ignores key order when comparing rates", () => {
		const current = decodePoyoV2Feed(h3Fixture);
		if (!current) throw new Error("Invalid H3 fixture");
		const reordered = decodePoyoV2Feed(
			JSON.parse(
				JSON.stringify({
					...h3Fixture,
					rates: {
						"h3-max": {
							resolutions: { "768p": "16", "480p": "10" },
							kind: "per-second-by-resolution",
						},
						"seedream-5.5": {
							perReference: "1.6",
							resolutions: { "2K": "7", "1.5K": "4", "1K": "4" },
							kind: "per-image-with-references",
						},
						"z-image": { credits: "2", kind: "per-request" },
					},
				}),
			),
		);
		if (!reordered) throw new Error("Invalid reordered fixture");
		expect(pricingFeedConflict(reordered, current)).toBeUndefined();
	});

	test("prefers v2 unless the selected v1 has a strictly newer source", async () => {
		const v1Path = pricingCachePath(directory, "poyo");
		const v1 = { ...poyoFeed, revision: "d".repeat(40) };
		await writeCache(v2Path(), { checkedAt, feed: later });
		await writeCache(v1Path, { checkedAt, feed: { ...v1, sourceDate: bundled.sourceDate } });
		expect<unknown>(await studio()).toEqual(later);
		const newer = { ...v1, sourceDate: iso(confirmed + day) };
		await writeCache(v1Path, { checkedAt, feed: newer });
		expect<unknown>(await studio()).toEqual(newer);
	});

	test("bounds cache files at 256 KiB", async () => {
		const bytes = 256 * 1024 + 1;
		await writeCache(v2Path(), `${JSON.stringify({ checkedAt, feed: later })}${" ".repeat(bytes)}`);
		expect<unknown>(await studio()).toEqual(bundled);
	});
});

describe("the Poyo.ai price basis", () => {
	const feed = decodePoyoV2Feed(pair.feed);
	const basis = decodePoyoBasis(pair.basis);
	if (!feed || !basis) throw new Error("The basis fixture does not decode.");
	const now = Date.parse(feed.confirmedAt) + day;
	const checkedAt = new Date(now).toISOString();
	const found = queueRows.find(({ rateKey }) => rateKey === "gpt-4o-image");
	if (!found) throw new Error("gpt-4o-image is not a queue row.");
	const target = found;
	const zImage = {
		provider: "poyo",
		model: "z-image",
		operation: "generate",
		options: { size: "1:1" },
		sourceCount: 0,
		count: 1,
		retryLimit: 0,
	};
	const paths = () => ({
		v2CachePath: pricingCachePath(directory, "poyo-v2"),
		cachePath: pricingCachePath(directory, "poyo"),
		bundledFeeds: { "poyo-v2": feed, "poyo-basis": basis },
	});
	const basisCache = () => poyoBasisPath(pricingCachePath(directory, "poyo-v2"));
	/** What Review sees: the derived quote, and the verified Z-Image quote beside it. */
	async function quotes(options: Parameters<typeof loadLocalPoyoPricing>[1] = paths()) {
		const pricing = await loadLocalPoyoPricing(now, options);
		const feeds = { poyo: pricing.feed, poyoBasis: pricing.basis };
		return {
			pricing,
			derived: estimateDerivedPrice(feeds, target, {}, now).status,
			verified: estimatePrice(pricing.feed, zImage, now).status,
		};
	}
	const later = { ...feed, confirmedAt: iso(Date.parse(feed.confirmedAt) + 1000) };
	const laterBasis = { ...basis, feedSha256: poyoFeedSha256(later) };

	test("the basis sits beside the v2 file it pairs with", () => {
		expect(poyoBasisPath("/custom/cache/siluet/pricing/v2/poyo.json")).toBe(
			"/custom/cache/siluet/pricing/v2/poyo-basis.json",
		);
		expect(poyoBasisPairs(feed, basis)).toBe(true);
		expect(poyoBasisPairs(later, basis)).toBe(false);
	});

	test("a derived row quotes from the bundled pair", async () => {
		expect(await quotes()).toEqual({
			pricing: { feed, basis },
			derived: "known",
			verified: "known",
		});
	});

	test("a cached pair replaces the bundled pair, and a restart reads it again", async () => {
		await writeCache(pricingCachePath(directory, "poyo-v2"), { checkedAt, feed: later });
		await writeCache(basisCache(), laterBasis);
		for (let run = 0; run < 2; run++) {
			expect(await quotes()).toEqual({
				pricing: { feed: later, basis: laterBasis },
				derived: "known",
				verified: "known",
			});
		}
	});

	test.each([
		["a missing bundled basis", () => ({ ...paths(), bundledFeeds: { "poyo-v2": feed } })],
		[
			"a bundled basis for another revision",
			() => ({
				...paths(),
				bundledFeeds: { "poyo-v2": feed, "poyo-basis": { ...basis, revision: "f".repeat(40) } },
			}),
		],
		[
			"a bundled basis for another body",
			() => ({
				...paths(),
				bundledFeeds: { "poyo-v2": feed, "poyo-basis": { ...basis, feedSha256: "f".repeat(64) } },
			}),
		],
	])("%s makes derived rates unknown while verified rates quote", async (_, options) => {
		const { pricing, derived, verified } = await quotes(options());
		expect(pricing).toEqual({ feed });
		expect([derived, verified]).toEqual(["unknown", "known"]);
	});

	test("a cached feed never pairs with the bundled basis", async () => {
		await writeCache(pricingCachePath(directory, "poyo-v2"), { checkedAt, feed: later });
		// The bundled basis would pair with the cached feed if the sources could mix.
		const options = { ...paths(), bundledFeeds: { "poyo-v2": feed, "poyo-basis": laterBasis } };
		const { pricing, derived, verified } = await quotes(options);
		expect(pricing).toEqual({ feed: later });
		expect([derived, verified]).toEqual(["unknown", "known"]);
	});

	test("a refresh that stopped between the two files leaves derived rates unknown", async () => {
		// The new feed landed, and the basis beside it still pairs with the earlier feed.
		await writeCache(pricingCachePath(directory, "poyo-v2"), { checkedAt, feed: later });
		await writeCache(basisCache(), basis);
		const { pricing, derived, verified } = await quotes();
		expect(pricing).toEqual({ feed: later });
		expect([derived, verified]).toEqual(["unknown", "known"]);
		await writeCache(basisCache(), "{");
		expect((await quotes()).pricing).toEqual({ feed: later });
	});

	test("a selected v1 feed carries no basis", async () => {
		const v1 = {
			version: 1,
			provider: "poyo",
			revision: "d".repeat(40),
			sourceDate: iso(Date.parse(feed.sourceDate) + 1000),
			rates: { "z-image": feed.rates["z-image"], "seedream-5.5": feed.rates["seedream-5.5"] },
		};
		await writeCache(pricingCachePath(directory, "poyo"), { checkedAt, feed: v1 });
		const { pricing, derived, verified } = await quotes();
		expect<unknown>(pricing).toEqual({ feed: v1 });
		expect([derived, verified]).toEqual(["unknown", "known"]);
	});

	test("Studio offers the basis only with the feed it pairs with", async () => {
		const bundled = decodePoyoV2Feed(poyoV2Bundle);
		if (!bundled) throw new Error("Invalid bundled v2 feed");
		const confirmed = Date.parse(bundled.confirmedAt) + day;
		const at = confirmed + day;
		const cached = {
			...bundled,
			confirmedAt: iso(confirmed),
			rates: { ...bundled.rates, "gpt-4o-image": { kind: "per-request", credits: "4" } },
		};
		const cachedBasis = {
			revision: cached.revision,
			feedSha256: poyoFeedSha256(cached),
			digests: { "gpt-4o-image": target.basis },
		};
		await writeCache(pricingCachePath(directory, "poyo-v2"), {
			checkedAt: new Date(at).toISOString(),
			feed: cached,
		});
		expect(await loadStudioPricingFeeds(at, directory)).toMatchObject({ poyo: cached });
		expect((await loadStudioPricingFeeds(at, directory)).poyoBasis).toBeUndefined();
		await writeCache(basisCache(), cachedBasis);
		const feeds = await loadStudioPricingFeeds(at, directory);
		expect(feeds).toMatchObject({ poyo: cached, poyoBasis: cachedBasis });
		expect(estimateDerivedPrice(feeds, target, {}, at)).toMatchObject({
			status: "known",
			perRequest: "4",
		});
	});

	// Until pricing-data publishes a basis and a re-bundle brings it to main, no basis is bundled.
	// The first re-bundle PR makes this test require the file unconditionally.
	test("a bundled basis on main pairs with the bundled v2 feed and is embedded", async () => {
		const bundledBasis = new URL("../../../../../pricing/v2/poyo-basis.json", import.meta.url);
		const studio = await loadStudioPricingFeeds(Date.parse(poyoV2Bundle.confirmedAt), directory);
		if (!(await Bun.file(bundledBasis).exists())) {
			expect(studio.poyoBasis).toBeUndefined();
			return;
		}
		const decoded = decodePoyoBasis(JSON.parse(await readFile(bundledBasis, "utf8")));
		const bundledFeed = decodePoyoV2Feed(poyoV2Bundle);
		if (!decoded || !bundledFeed) throw new Error("The bundled pair does not decode.");
		expect(decoded.revision).toBe(bundledFeed.revision);
		expect(decoded.feedSha256).toBe(poyoFeedSha256(bundledFeed));
		expect(studio.poyoBasis).toEqual(decoded);
	});
});
