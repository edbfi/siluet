import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import poyoBundle from "../../pricing/v2/poyo.json";
import toapisBundle from "../../pricing/v2/toapis.json";
import { pricingCachePath } from "../../src/lib/server/services/pricing/local-feed";
import { toapisRates } from "./toapis-feed";

export async function writeReviewPricing(
	cacheHome: string,
	cachedSeconds = 2 * 24 * 60 * 60,
	zImageCredits?: string,
	extraPoyoRates: Record<string, unknown> = {},
) {
	const latest = Math.max(Date.parse(poyoBundle.sourceDate), Date.parse(toapisBundle.observedAt));
	// Keep cached conversion evidence at least as recent as the bundle.
	const observedMs = Math.floor(Math.max(latest + cachedSeconds * 1000, Date.now()) / 1000) * 1000;
	const observedAt = new Date(observedMs).toISOString().replace(".000Z", "Z");
	// A cache replaces the bundle only with a confirmation at least as recent as the bundle's.
	const confirmedAt = [observedAt, poyoBundle.confirmedAt].sort().at(-1) ?? observedAt;
	const poyo = {
		version: 2,
		provider: "poyo",
		revision: (poyoBundle.revision[0] === "a" ? "b" : "a").repeat(40),
		sourceDate: observedAt,
		confirmedAt,
		rates: {
			"z-image": zImageCredits
				? { kind: "per-request", credits: zImageCredits }
				: { kind: "unavailable" },
			"seedream-5.5": {
				kind: "per-image-with-references",
				resolutions: { "1K": "4", "1.5K": "4", "2K": "7" },
				perReference: "1.6",
			},
			...extraPoyoRates,
		},
	};
	const toapis = { ...toapisRates, observedAt, conversionCacheAgeSeconds: cachedSeconds };
	const poyoPath = pricingCachePath(cacheHome, "poyo-v2");
	const toapisPath = pricingCachePath(cacheHome, "toapis");
	await Promise.all(
		[poyoPath, toapisPath].map((path) => mkdir(dirname(path), { recursive: true })),
	);
	await Promise.all([
		Bun.write(poyoPath, JSON.stringify({ checkedAt: confirmedAt, feed: poyo })),
		Bun.write(toapisPath, JSON.stringify({ checkedAt: observedAt, feed: toapis })),
	]);
	return {
		observedMs,
		observedAt,
		toapisExpiry: observedMs + (30 * 24 * 60 * 60 - cachedSeconds) * 1000,
	};
}
