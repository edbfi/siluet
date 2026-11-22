import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import poyoFeed from "../../../../../pricing/v1/feed.json";
import toapisFeed from "../../../../../pricing/v1/toapis.json";
import poyoV2Bundle from "../../../../../pricing/v2/poyo.json";
import h3Fixture from "../../../../../tests/fixtures/h3-rate.v2.json";
import { decodePoyoV2Feed } from "../../../shared/pricing/poyo-feed";
import {
	loadLocalPricing,
	loadStudioPricingFeeds,
	pricingCachePath,
	pricingFeedConflict,
} from "./local-feed";

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
	const sourceTime = Date.parse(poyoFeed.sourceDate);
	const now = sourceTime + 2 * day;
	const check = new Date(now).toISOString();
	const candidate = {
		...poyoFeed,
		revision: (poyoFeed.revision[0] === "a" ? "b" : "a").repeat(40),
		sourceDate: new Date(sourceTime + day).toISOString(),
	};
	const rollback = { ...candidate, sourceDate: new Date(sourceTime - day).toISOString() };
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
		expect<unknown>(
			await loadLocalPricing(now, {
				cachePath: pricingCachePath(directory, "poyo"),
				v2CachePath: v2Path(),
			}),
		).toEqual(bundled);
	});
});
