import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import poyoFeed from "../../../../../pricing/v1/feed.json";
import toapisFeed from "../../../../../pricing/v1/toapis.json";
import poyoV2Feed from "../../../../../pricing/v2/poyo.json";
import {
	decodePricingFeed,
	isPricingClock,
	isPricingRecord,
	parsePricingInstant,
} from "../../../shared/pricing/feed";
import {
	type PricingFeeds,
	type PricingProvider,
	type ProviderPricingFeed,
	pricingSourceDate,
} from "../../../shared/pricing/feeds";
import {
	decodePoyoV2Feed,
	type PoyoPricingFeed,
	poyoConfirmationMs,
} from "../../../shared/pricing/poyo-feed";
import {
	decodeToapisPricingFeed,
	toapisEffectiveObservations,
} from "../../../shared/pricing/toapis-feed";

/** A local pricing file. `poyo` is the v1 Poyo.ai feed and `poyo-v2` its confirmed successor. */
export type PricingFile = PricingProvider | "poyo-v2";
export type PricingPaths = {
	provider?: PricingProvider;
	bundledPath?: string;
	cachePath?: string;
	/** Poyo.ai only: the v2 files, selected alongside the v1 files above. */
	v2BundledPath?: string;
	v2CachePath?: string;
};
export type CachedPricingFeed = { checkedAt: string; feed: ProviderPricingFeed };
export const pricingFeedByteLimit = 16 * 1024;
/** Bundled and cached v2 files leave room for the cache wrapper around a 64 KiB feed. */
export const poyoV2FileByteLimit = 256 * 1024;

const pricingFiles = {
	poyo: { directory: "v1", name: "feed.json", byteLimit: pricingFeedByteLimit },
	"poyo-v2": { directory: "v2", name: "poyo.json", byteLimit: poyoV2FileByteLimit },
	toapis: { directory: "v1", name: "toapis.json", byteLimit: pricingFeedByteLimit },
} as const satisfies Record<PricingFile, unknown>;

export function pricingFileLocation(file: PricingFile): string {
	const { directory, name } = pricingFiles[file];
	return `${directory}/${name}`;
}

const bundledFeeds = {
	poyo: decodePricingFeed(poyoFeed),
	"poyo-v2": decodePoyoV2Feed(poyoV2Feed),
	toapis: decodeToapisPricingFeed(toapisFeed),
} satisfies Record<PricingFile, ProviderPricingFeed | undefined>;

export function pricingCachePath(
	cacheHome = process.env.XDG_CACHE_HOME,
	file: PricingFile = "poyo",
): string {
	const directory = cacheHome && isAbsolute(cacheHome) ? cacheHome : join(homedir(), ".cache");
	const { directory: version, name } = pricingFiles[file];
	return join(directory, "siluet", "pricing", version, name);
}

export function decodePricingFile(
	file: PricingFile,
	value: unknown,
): ProviderPricingFeed | undefined {
	if (file === "poyo") return decodePricingFeed(value);
	if (file === "poyo-v2") return decodePoyoV2Feed(value);
	return decodeToapisPricingFeed(value);
}

function canonicalJson(value: unknown): string {
	return JSON.stringify(value, (_key, field: unknown) =>
		isPricingRecord(field)
			? Object.fromEntries(Object.entries(field).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
			: field,
	);
}

/** At one revision, keep every key and every rate that is not `unavailable`. */
function preservesPoyoRates(candidate: PoyoPricingFeed, current: PoyoPricingFeed): boolean {
	const nextRates: Readonly<Record<string, unknown>> = candidate.rates;
	return Object.entries(current.rates).every(
		([model, rate]) =>
			Object.hasOwn(nextRates, model) &&
			(rate.kind === "unavailable" || canonicalJson(rate) === canonicalJson(nextRates[model])),
	);
}

function poyoFeedConflict(
	candidate: PoyoPricingFeed,
	current: PoyoPricingFeed,
): "rollback" | "revision conflict" | undefined {
	if (candidate.version !== current.version) return "revision conflict";
	// Source and confirmation ordering are independent. Neither may move backwards.
	if (poyoConfirmationMs(candidate) < poyoConfirmationMs(current)) return "rollback";
	const candidateTime = parsePricingInstant(candidate.sourceDate);
	const currentTime = parsePricingInstant(current.sourceDate);
	if (candidate.revision === current.revision) {
		return candidateTime !== currentTime || !preservesPoyoRates(candidate, current)
			? "revision conflict"
			: undefined;
	}
	if (candidateTime === currentTime) return "revision conflict";
	if (candidateTime < currentTime) return "rollback";
}

export function pricingFeedConflict(
	candidate: ProviderPricingFeed,
	current: ProviderPricingFeed,
): "rollback" | "revision conflict" | undefined {
	if (candidate.provider === "poyo" && current.provider === "poyo") {
		return poyoFeedConflict(candidate, current);
	}
	if (candidate.provider !== "toapis" || current.provider !== "toapis") return "revision conflict";
	const candidateTime = parsePricingInstant(candidate.observedAt);
	const currentTime = parsePricingInstant(current.observedAt);
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
	if (candidateTime < currentTime) return "rollback";
}

async function readLocalJson(path: string, byteLimit: number): Promise<unknown> {
	try {
		const bytes = await Bun.file(path)
			.slice(0, byteLimit + 1)
			.arrayBuffer();
		if (bytes.byteLength > byteLimit) return null;
		return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) ?? null;
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
		return null;
	}
}

function decodeCache(file: PricingFile, value: unknown): CachedPricingFeed | undefined {
	if (!isPricingRecord(value) || Object.keys(value).length !== 2) return;
	const { checkedAt, feed: rawFeed } = value;
	if (typeof checkedAt !== "string") return;
	const checkTime = parsePricingInstant(checkedAt);
	if (!Number.isFinite(checkTime)) return;
	const feed = decodePricingFile(file, rawFeed);
	if (!feed || parsePricingInstant(pricingSourceDate(feed)) > checkTime) return;
	if (feed.provider === "poyo" && poyoConfirmationMs(feed) > checkTime) return;
	return { checkedAt, feed };
}

export async function readLocalPricing(
	bundledPath: string | undefined,
	cachePath: string,
	file: PricingFile,
): Promise<{
	bundled: ProviderPricingFeed | undefined;
	cache: CachedPricingFeed | null | undefined;
}> {
	const [bundled, cache] = await Promise.all([
		loadBundledFile(file, bundledPath),
		readLocalJson(cachePath, pricingFiles[file].byteLimit),
	]);
	return {
		bundled,
		cache: cache === undefined ? undefined : (decodeCache(file, cache) ?? null),
	};
}

async function loadBundledFile(
	file: PricingFile,
	bundledPath?: string,
): Promise<ProviderPricingFeed | undefined> {
	return bundledPath === undefined
		? bundledFeeds[file]
		: decodePricingFile(file, await readLocalJson(bundledPath, pricingFiles[file].byteLimit));
}

/** Prefer the confirmed v2 feed unless the v1 feed has a strictly newer source. */
function preferPoyoFeed(
	v1: ProviderPricingFeed | undefined,
	v2: ProviderPricingFeed | undefined,
): ProviderPricingFeed | undefined {
	if (!v1 || !v2) return v2 ?? v1;
	return parsePricingInstant(pricingSourceDate(v1)) > parsePricingInstant(pricingSourceDate(v2))
		? v1
		: v2;
}

export async function loadBundledPricing(
	provider: PricingProvider,
	{ bundledPath, v2BundledPath }: Pick<PricingPaths, "bundledPath" | "v2BundledPath"> = {},
): Promise<ProviderPricingFeed | undefined> {
	if (provider === "toapis") return loadBundledFile(provider, bundledPath);
	const [v1, v2] = await Promise.all([
		loadBundledFile("poyo", bundledPath),
		loadBundledFile("poyo-v2", v2BundledPath),
	]);
	return preferPoyoFeed(v1, v2);
}

async function selectLocalFile(
	file: PricingFile,
	bundledPath: string | undefined,
	cachePath: string,
): Promise<ProviderPricingFeed | undefined> {
	const { bundled, cache } = await readLocalPricing(bundledPath, cachePath, file);
	if (!cache || (bundled && pricingFeedConflict(cache.feed, bundled))) return bundled;
	// Keep the newest source after a clock correction. The calculator checks source time itself.
	return cache.feed;
}

export async function loadLocalPricing(
	nowMs: number,
	{
		provider = "poyo",
		bundledPath,
		cachePath = pricingCachePath(undefined, provider),
		v2BundledPath,
		v2CachePath = pricingCachePath(undefined, "poyo-v2"),
	}: PricingPaths = {},
): Promise<ProviderPricingFeed | undefined> {
	if (!isPricingClock(nowMs)) return;
	if (provider === "toapis") return selectLocalFile(provider, bundledPath, cachePath);
	const [v1, v2] = await Promise.all([
		selectLocalFile("poyo", bundledPath, cachePath),
		selectLocalFile("poyo-v2", v2BundledPath, v2CachePath),
	]);
	return preferPoyoFeed(v1, v2);
}

/** Load the selected local snapshots for use during browser-only composition and review. */
export async function loadStudioPricingFeeds(
	nowMs: number,
	cacheHome?: string,
): Promise<PricingFeeds> {
	const [poyo, toapis] = await Promise.all([
		loadLocalPricing(nowMs, {
			provider: "poyo",
			cachePath: pricingCachePath(cacheHome, "poyo"),
			v2CachePath: pricingCachePath(cacheHome, "poyo-v2"),
		}),
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
