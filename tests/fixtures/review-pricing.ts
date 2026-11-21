import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import poyoBundle from "../../pricing/v1/feed.json";
import toapisBundle from "../../pricing/v1/toapis.json";
import { pricingCachePath } from "../../src/lib/server/services/pricing/local-feed";
import { toapisRates } from "./toapis-feed";

export async function writeReviewPricing(cacheHome: string) {
	const cachedSeconds = 2 * 24 * 60 * 60;
	const latest = Math.max(Date.parse(poyoBundle.sourceDate), Date.parse(toapisBundle.observedAt));
	// Keep the two-day-old conversion evidence newer than the bundle. The browser clock follows observedMs.
	const observedMs =
		Math.floor(Math.max(latest + cachedSeconds * 1000, Date.now()) / 1000) * 1000 + 1000;
	const observedAt = new Date(observedMs).toISOString().replace(".000Z", "Z");
	const poyo = {
		version: 1,
		provider: "poyo",
		revision: (poyoBundle.revision[0] === "a" ? "b" : "a").repeat(40),
		sourceDate: observedAt,
		rates: {
			"z-image": { kind: "unavailable" },
			"seedream-5.5": {
				kind: "per-image-with-references",
				resolutions: { "1K": "4", "1.5K": "4", "2K": "7" },
				perReference: "1.6",
			},
		},
	};
	const toapis = { ...toapisRates, observedAt, conversionCacheAgeSeconds: cachedSeconds };
	const poyoPath = pricingCachePath(cacheHome, "poyo");
	await mkdir(dirname(poyoPath), { recursive: true });
	await Promise.all([
		Bun.write(poyoPath, JSON.stringify({ checkedAt: observedAt, feed: poyo })),
		Bun.write(
			pricingCachePath(cacheHome, "toapis"),
			JSON.stringify({ checkedAt: observedAt, feed: toapis }),
		),
	]);
	return { observedMs, observedAt, toapisExpiry: observedMs + 28 * 24 * 60 * 60 * 1000 };
}
