import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import {
	decodePricingFeed,
	isPricingClock,
	isPricingRecord,
	parsePricingInstant,
} from "../../../shared/pricing/feed";
import {
	type PricingProvider,
	type ProviderPricingFeed,
	pricingSourceDate,
} from "../../../shared/pricing/feeds";
import {
	decodePoyoV2Feed,
	type PoyoPricingFeed,
	type PoyoPricingFeedV2,
	poyoConfirmationMs,
} from "../../../shared/pricing/poyo-feed";
import {
	decodeToapisPricingFeed,
	toapisEffectiveObservations,
} from "../../../shared/pricing/toapis-feed";

/**
 * A local pricing file. `poyo` is the v1 Poyo.ai feed and `poyo-v2` its confirmed successor.
 * `toapis` is the v2 ToAPIs feed. The frozen v1 ToAPIs feed is never read.
 */
export type PricingFile = PricingProvider | "poyo-v2";
/** Feeds already in memory, such as those embedded in the Studio build. */
export type BundledPricingFeeds = Readonly<
	Partial<Record<PricingFile, ProviderPricingFeed | undefined>>
>;
export type PricingPaths = {
	provider?: PricingProvider;
	/** Read bundled files from these paths, else use `bundledFeeds`. */
	bundledFeeds?: BundledPricingFeeds;
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
	toapis: { directory: "v2", name: "toapis.json", byteLimit: pricingFeedByteLimit },
} as const satisfies Record<PricingFile, unknown>;

export function pricingFileLocation(file: PricingFile): string {
	const { directory, name } = pricingFiles[file];
	return `${directory}/${name}`;
}

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

/**
 * Compact JSON with every record's keys sorted, so key order never makes two feeds differ. It
 * serialises records itself: an object would put integer-like keys such as "5" before "10" and
 * ahead of the rest, where `jq -S` and the published blob sort them as strings.
 */
export function canonicalJson(value: unknown): string {
	return serialize(value) ?? "null";
}

function serialize(value: unknown): string | undefined {
	if (Array.isArray(value)) return `[${value.map((item) => serialize(item) ?? "null").join(",")}]`;
	if (!isPricingRecord(value)) return JSON.stringify(value);
	const members = Object.keys(value)
		.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
		.flatMap((key) => {
			const field = serialize(value[key]);
			return field === undefined ? [] : [`${JSON.stringify(key)}:${field}`];
		});
	return `{${members.join(",")}}`;
}

/** The SHA-256 a price basis records for its feed: canonical JSON, with no trailing LF. */
export function poyoFeedSha256(feed: PoyoPricingFeedV2): string {
	return createHash("sha256").update(canonicalJson(feed)).digest("hex");
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

/** A bundled feed as a file path, an in-memory feed, or none. */
type BundledSource = string | ProviderPricingFeed | undefined;

export async function readLocalPricing(
	bundledSource: BundledSource,
	cachePath: string,
	file: PricingFile,
): Promise<{
	bundled: ProviderPricingFeed | undefined;
	cache: CachedPricingFeed | null | undefined;
}> {
	const [bundled, cache] = await Promise.all([
		loadBundledFile(file, bundledSource),
		readLocalJson(cachePath, pricingFiles[file].byteLimit),
	]);
	return {
		bundled,
		cache: cache === undefined ? undefined : (decodeCache(file, cache) ?? null),
	};
}

async function loadBundledFile(
	file: PricingFile,
	source: BundledSource,
): Promise<ProviderPricingFeed | undefined> {
	return typeof source === "string"
		? decodePricingFile(file, await readLocalJson(source, pricingFiles[file].byteLimit))
		: source;
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
	{
		bundledFeeds,
		bundledPath,
		v2BundledPath,
	}: Pick<PricingPaths, "bundledFeeds" | "bundledPath" | "v2BundledPath">,
): Promise<ProviderPricingFeed | undefined> {
	if (provider === "toapis") {
		return loadBundledFile(provider, bundledPath ?? bundledFeeds?.toapis);
	}
	const [v1, v2] = await Promise.all([
		loadBundledFile("poyo", bundledPath ?? bundledFeeds?.poyo),
		loadBundledFile("poyo-v2", v2BundledPath ?? bundledFeeds?.["poyo-v2"]),
	]);
	return preferPoyoFeed(v1, v2);
}

async function selectLocalFile(
	file: PricingFile,
	bundledSource: BundledSource,
	cachePath: string,
): Promise<ProviderPricingFeed | undefined> {
	const { bundled, cache } = await readLocalPricing(bundledSource, cachePath, file);
	if (!cache || (bundled && pricingFeedConflict(cache.feed, bundled))) return bundled;
	// Keep the newest source after a clock correction. The calculator checks source time itself.
	return cache.feed;
}

export async function loadLocalPricing(
	nowMs: number,
	{
		provider = "poyo",
		bundledFeeds,
		bundledPath,
		cachePath = pricingCachePath(undefined, provider),
		v2BundledPath,
		v2CachePath = pricingCachePath(undefined, "poyo-v2"),
	}: PricingPaths = {},
): Promise<ProviderPricingFeed | undefined> {
	if (!isPricingClock(nowMs)) return;
	if (provider === "toapis") {
		return selectLocalFile(provider, bundledPath ?? bundledFeeds?.toapis, cachePath);
	}
	const [v1, v2] = await Promise.all([
		selectLocalFile("poyo", bundledPath ?? bundledFeeds?.poyo, cachePath),
		selectLocalFile("poyo-v2", v2BundledPath ?? bundledFeeds?.["poyo-v2"], v2CachePath),
	]);
	return preferPoyoFeed(v1, v2);
}
