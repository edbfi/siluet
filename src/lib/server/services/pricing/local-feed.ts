import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import poyoFeed from "../../../../../pricing/v1/feed.json";
import toapisFeed from "../../../../../pricing/v1/toapis.json";
import {
	decodePricingFeed,
	isPricingClock,
	isPricingRecord,
	type PricingFeed,
	parsePricingInstant,
} from "../../../shared/pricing/feed";
import {
	type PricingFeeds,
	type PricingProvider,
	type ProviderPricingFeed,
	pricingSourceDate,
} from "../../../shared/pricing/feeds";
import {
	decodeToapisPricingFeed,
	toapisEffectiveObservations,
} from "../../../shared/pricing/toapis-feed";

export type PricingPaths = { provider?: PricingProvider; bundledPath?: string; cachePath?: string };
export type CachedPricingFeed = { checkedAt: string; feed: ProviderPricingFeed };
export const pricingFeedByteLimit = 16 * 1024;

export const pricingFilenames = { poyo: "feed.json", toapis: "toapis.json" } as const;

const bundledFeeds = {
	poyo: decodePricingFeed(poyoFeed),
	toapis: decodeToapisPricingFeed(toapisFeed),
};

export function pricingCachePath(
	cacheHome = process.env.XDG_CACHE_HOME,
	provider: PricingProvider = "poyo",
): string {
	const directory = cacheHome && isAbsolute(cacheHome) ? cacheHome : join(homedir(), ".cache");
	return join(directory, "siluet", "pricing", "v1", pricingFilenames[provider]);
}

export function decodeProviderFeed(
	provider: PricingProvider,
	value: unknown,
): ProviderPricingFeed | undefined {
	return provider === "poyo" ? decodePricingFeed(value) : decodeToapisPricingFeed(value);
}

function preservesPoyoRates(candidate: PricingFeed, current: PricingFeed): boolean {
	const models = ["z-image", "seedream-5.5"] as const;
	return models.every((model) => {
		const oldRate = current.rates[model];
		const nextRate = candidate.rates[model];
		return oldRate.kind === "unavailable" || JSON.stringify(oldRate) === JSON.stringify(nextRate);
	});
}

export function pricingFeedConflict(
	candidate: ProviderPricingFeed,
	current: ProviderPricingFeed,
): "rollback" | "revision conflict" | undefined {
	const candidateTime = parsePricingInstant(pricingSourceDate(candidate));
	const currentTime = parsePricingInstant(pricingSourceDate(current));
	if (candidate.provider === "poyo" && current.provider === "poyo") {
		if (candidate.revision === current.revision) {
			if (candidateTime !== currentTime || !preservesPoyoRates(candidate, current)) {
				return "revision conflict";
			}
			return;
		}
		if (candidateTime === currentTime) return "revision conflict";
	} else if (candidate.provider === "toapis" && current.provider === "toapis") {
		if (
			candidateTime === currentTime &&
			JSON.stringify({ ...candidate, observedAt: current.observedAt }) !== JSON.stringify(current)
		) {
			return "revision conflict";
		}
		const prior = toapisEffectiveObservations(current);
		if (toapisEffectiveObservations(candidate).some((time, index) => time < prior[index])) {
			return "rollback";
		}
	} else {
		return "revision conflict";
	}
	if (candidateTime < currentTime) return "rollback";
}

async function readLocalJson(path: string): Promise<unknown> {
	try {
		const bytes = await Bun.file(path)
			.slice(0, pricingFeedByteLimit + 1)
			.arrayBuffer();
		if (bytes.byteLength > pricingFeedByteLimit) return null;
		return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) ?? null;
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
		return null;
	}
}

function decodeCache(provider: PricingProvider, value: unknown): CachedPricingFeed | undefined {
	if (!isPricingRecord(value) || Object.keys(value).length !== 2) return;
	const { checkedAt, feed: rawFeed } = value;
	if (typeof checkedAt !== "string") return;
	const checkTime = parsePricingInstant(checkedAt);
	if (!Number.isFinite(checkTime)) return;
	const feed = decodeProviderFeed(provider, rawFeed);
	if (!feed || parsePricingInstant(pricingSourceDate(feed)) > checkTime) return;
	return { checkedAt, feed };
}

export async function readLocalPricing(
	bundledPath: string | undefined,
	cachePath: string,
	provider: PricingProvider,
): Promise<{
	bundled: ProviderPricingFeed | undefined;
	cache: CachedPricingFeed | null | undefined;
}> {
	const [bundled, cache] = await Promise.all([
		loadBundledPricing(provider, bundledPath),
		readLocalJson(cachePath),
	]);
	return {
		bundled,
		cache: cache === undefined ? undefined : (decodeCache(provider, cache) ?? null),
	};
}

export async function loadBundledPricing(
	provider: PricingProvider,
	bundledPath?: string,
): Promise<ProviderPricingFeed | undefined> {
	return bundledPath === undefined
		? bundledFeeds[provider]
		: decodeProviderFeed(provider, await readLocalJson(bundledPath));
}

export async function loadLocalPricing(
	nowMs: number,
	{
		provider = "poyo",
		bundledPath,
		cachePath = pricingCachePath(undefined, provider),
	}: PricingPaths = {},
): Promise<ProviderPricingFeed | undefined> {
	if (!isPricingClock(nowMs)) return;
	const { bundled, cache } = await readLocalPricing(bundledPath, cachePath, provider);
	if (!cache || (bundled && pricingFeedConflict(cache.feed, bundled))) return bundled;
	// Keep the newest source after a clock correction. The calculator checks source time itself.
	return cache.feed;
}

/** Load the selected local snapshots for use during browser-only composition and review. */
export async function loadStudioPricingFeeds(
	nowMs: number,
	cacheHome?: string,
): Promise<PricingFeeds> {
	const [poyo, toapis] = await Promise.all([
		loadLocalPricing(nowMs, { provider: "poyo", cachePath: pricingCachePath(cacheHome, "poyo") }),
		loadLocalPricing(nowMs, {
			provider: "toapis",
			cachePath: pricingCachePath(cacheHome, "toapis"),
		}),
	]);
	return {
		poyo: poyo?.provider === "poyo" ? poyo : undefined,
		toapis: toapis?.provider === "toapis" ? toapis : undefined,
	};
}
