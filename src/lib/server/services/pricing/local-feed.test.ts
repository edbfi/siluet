import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import poyoFeed from "../../../../../pricing/v1/feed.json";
import toapisFeed from "../../../../../pricing/v1/toapis.json";
import { loadStudioPricingFeeds, pricingCachePath } from "./local-feed";

test("Studio resolves each provider from embedded pricing and a valid newer local cache", async () => {
	const directory = await mkdtemp(join(tmpdir(), "siluet-review-prices-"));
	const sourceTime = Date.parse(poyoFeed.sourceDate);
	const day = 24 * 60 * 60 * 1000;
	const now = sourceTime + 2 * day;
	const check = new Date(now).toISOString();
	const candidate = {
		...poyoFeed,
		revision: (poyoFeed.revision[0] === "a" ? "b" : "a").repeat(40),
		sourceDate: new Date(sourceTime + day).toISOString(),
	};
	const rollback = { ...candidate, sourceDate: new Date(sourceTime - day).toISOString() };
	try {
		const path = pricingCachePath(directory, "poyo");
		await mkdir(dirname(path), { recursive: true });
		expect<unknown>(await loadStudioPricingFeeds(now, directory)).toEqual({
			poyo: poyoFeed,
			toapis: toapisFeed,
		});
		await Bun.write(path, JSON.stringify({ checkedAt: check, feed: candidate }));
		expect<unknown>(await loadStudioPricingFeeds(now, directory)).toEqual({
			poyo: candidate,
			toapis: toapisFeed,
		});
		await Bun.write(
			path,
			JSON.stringify({
				checkedAt: check,
				feed: rollback,
			}),
		);
		expect<unknown>(await loadStudioPricingFeeds(now, directory)).toEqual({
			poyo: poyoFeed,
			toapis: toapisFeed,
		});
		await Bun.write(path, "not json");
		expect<unknown>(await loadStudioPricingFeeds(now, directory)).toEqual({
			poyo: poyoFeed,
			toapis: toapisFeed,
		});
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
