import { randomUUID } from "node:crypto";
import { mkdir, open, realpath, rename, rm, rmdir } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { isPricingClock, parsePricingInstant } from "../../src/lib/shared/pricing/feed";
import {
	isPricingProvider,
	type ProviderPricingFeed,
	pricingSourceDate,
} from "../../src/lib/shared/pricing/feeds";
import { poyoConfirmationMs, poyoFeedExpiryMs } from "../../src/lib/shared/pricing/poyo-feed";
import { toapisFeedExpiryMs } from "../../src/lib/shared/pricing/toapis-feed";
import {
	type CachedPricingFeed,
	canonicalJson,
	decodePricingFile,
	type PricingFile,
	type PricingPaths,
	poyoV2FileByteLimit,
	pricingBundledPath,
	pricingCachePath,
	pricingFeedByteLimit,
	pricingFeedConflict,
	readLocalPricing,
} from "./local-feed";

export const pricingFeedUrl =
	"https://raw.githubusercontent.com/edbfi/siluet/pricing-data/pricing/v1/feed.json";
export const poyoV2PricingFeedUrl =
	"https://raw.githubusercontent.com/edbfi/siluet/pricing-data/pricing/v2/poyo.json";
export const toapisPricingFeedUrl =
	"https://raw.githubusercontent.com/edbfi/siluet/pricing-data-toapis/pricing/v1/toapis.json";
const refreshTimeoutMs = 5_000;
/** The published v2 feed, including its trailing LF, fits in 64 KiB. */
export const poyoV2WireByteLimit = 64 * 1024;

const refreshFiles = {
	poyo: { url: pricingFeedUrl, wireLimit: pricingFeedByteLimit, cacheLimit: pricingFeedByteLimit },
	"poyo-v2": {
		url: poyoV2PricingFeedUrl,
		wireLimit: poyoV2WireByteLimit,
		cacheLimit: poyoV2FileByteLimit,
	},
	toapis: {
		url: toapisPricingFeedUrl,
		wireLimit: pricingFeedByteLimit,
		cacheLimit: pricingFeedByteLimit,
	},
} as const satisfies Record<PricingFile, unknown>;

type RefreshOptions = PricingPaths & {
	fetchFeed?: (url: string, init: RequestInit) => Promise<Response>;
	now?: () => number;
	timeoutMs?: number;
};

type RefreshResult = CachedPricingFeed & { status: "updated" | "unchanged"; cachePath: string };

async function readFeed(
	file: PricingFile,
	response: Response,
	signal: AbortSignal,
): Promise<ProviderPricingFeed> {
	if (response.status !== 200 || response.redirected || !response.body) {
		void response.body?.cancel().catch(() => {});
		throw new Error(`Pricing feed request failed (HTTP ${response.status}).`);
	}
	const byteLimit = refreshFiles[file].wireLimit;
	if (Number(response.headers.get("content-length")) > byteLimit) {
		void response.body.cancel().catch(() => {});
		throw new Error("Pricing feed exceeds the size limit.");
	}

	const reader = response.body.getReader();
	const cancel = () => {
		void reader.cancel().catch(() => {});
	};
	signal.addEventListener("abort", cancel, { once: true });
	const bytes = new Uint8Array(byteLimit);
	let length = 0;
	try {
		signal.throwIfAborted();
		for (;;) {
			const chunk = await reader.read();
			if (chunk.done) break;
			if (chunk.value.length > bytes.length - length) {
				throw new Error("Pricing feed exceeds the size limit.");
			}
			bytes.set(chunk.value, length);
			length += chunk.value.length;
		}
		signal.throwIfAborted();
	} finally {
		signal.removeEventListener("abort", cancel);
		cancel();
		reader.releaseLock();
	}

	let feed: ProviderPricingFeed | undefined;
	try {
		const json = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length));
		feed = decodePricingFile(file, JSON.parse(json));
	} catch {
		throw new Error("Pricing feed is not valid UTF-8 JSON.");
	}
	if (!feed) throw new Error("Pricing feed has an invalid schema.");
	return feed;
}

/** Serialise a cache entry, refusing one the reader would reject for its size. */
export function encodeCacheEntry(file: PricingFile, entry: CachedPricingFeed): string {
	// The v2 cache stays compact so a 64 KiB feed always fits.
	const json = file === "poyo-v2" ? JSON.stringify(entry) : JSON.stringify(entry, null, "\t");
	const text = `${json}\n`;
	if (new TextEncoder().encode(text).byteLength > refreshFiles[file].cacheLimit) {
		throw new Error("Pricing cache entry exceeds the size limit.");
	}
	return text;
}

async function replaceCache(path: string, text: string): Promise<void> {
	const temporary = join(dirname(path), `.feed-${randomUUID()}.tmp`);
	const file = await open(temporary, "wx", 0o600);
	try {
		try {
			await file.writeFile(text);
			await file.sync();
		} finally {
			await file.close();
		}
		await rename(temporary, path);
	} finally {
		await rm(temporary, { force: true });
	}
}

function evidenceMs(feed: ProviderPricingFeed): number {
	return feed.provider === "poyo"
		? poyoConfirmationMs(feed)
		: parsePricingInstant(pricingSourceDate(feed));
}

async function saveFeed(
	file: PricingFile,
	cachePath: string,
	bundledPath: string,
	feed: ProviderPricingFeed,
	nowMs: number,
): Promise<RefreshResult> {
	const cacheDirectory = dirname(cachePath);
	await mkdir(cacheDirectory, { recursive: true, mode: 0o700 });
	if (basename(cachePath) === basename(bundledPath)) {
		const bundledDirectory = await realpath(dirname(bundledPath)).catch((error: unknown) => {
			if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
			throw error;
		});
		if (bundledDirectory === (await realpath(cacheDirectory))) {
			throw new Error("Pricing cache and bundled snapshot must use separate paths.");
		}
	}
	// Keep the rollback check and atomic replacement in the same critical section.
	const lock = `${cachePath}.lock`;
	try {
		await mkdir(lock);
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "EEXIST") {
			throw new Error(
				`Pricing refresh cache is locked at ${lock}. If no refresh is running, use rmdir to remove only that empty lock directory and retry.`,
			);
		}
		throw error;
	}
	try {
		const { bundled, cache } = await readLocalPricing(bundledPath, cachePath, file);
		if (!bundled && cache === null) {
			throw new Error("Pricing cache is invalid and the bundled snapshot is unavailable.");
		}
		// A v2 confirmation is never earlier than its source, so this covers both dates.
		if (cache && evidenceMs(cache.feed) > nowMs) {
			throw new Error(
				`Pricing cache source is dated in the future at ${cachePath}. Check the device date and retry.`,
			);
		}
		for (const previous of [bundled, cache?.feed]) {
			if (!previous) continue;
			const conflict = pricingFeedConflict(feed, previous);
			if (conflict) throw new Error(`Pricing feed rejected due to ${conflict}.`);
		}
		const previous = cache?.feed ?? bundled;
		const status = canonicalJson(feed) === canonicalJson(previous) ? "unchanged" : "updated";
		const checkedAt = new Date(nowMs).toISOString();
		await replaceCache(cachePath, encodeCacheEntry(file, { checkedAt, feed }));
		return { status, checkedAt, feed, cachePath };
	} finally {
		await rmdir(lock);
	}
}

function requestFeed(
	file: PricingFile,
	fetchFeed: NonNullable<RefreshOptions["fetchFeed"]>,
	signal: AbortSignal,
) {
	return fetchFeed(refreshFiles[file].url, {
		method: "GET",
		redirect: "error",
		credentials: "omit",
		signal,
	});
}

export async function refreshPricingFeed({
	provider = "poyo",
	bundledPath = pricingBundledPath(provider),
	cachePath = pricingCachePath(undefined, provider),
	v2BundledPath = pricingBundledPath("poyo-v2"),
	v2CachePath = pricingCachePath(undefined, "poyo-v2"),
	fetchFeed = fetch,
	now = Date.now,
	timeoutMs = refreshTimeoutMs,
}: RefreshOptions = {}): Promise<RefreshResult> {
	const paths = {
		poyo: { bundledPath, cachePath },
		"poyo-v2": { bundledPath: v2BundledPath, cachePath: v2CachePath },
		toapis: { bundledPath, cachePath },
	} satisfies Record<PricingFile, unknown>;
	for (const file of provider === "poyo" ? (["poyo", "poyo-v2"] as const) : [provider]) {
		if (resolve(paths[file].cachePath) === resolve(paths[file].bundledPath)) {
			throw new Error("Pricing cache and bundled snapshot must use separate paths.");
		}
	}
	const signal = AbortSignal.timeout(timeoutMs);
	let file: PricingFile = provider === "poyo" ? "poyo-v2" : provider;
	let response = await requestFeed(file, fetchFeed, signal);
	if (file === "poyo-v2" && response.status === 404) {
		// Publication of the confirmed feed has not started yet. Refresh the v1 feed instead.
		void response.body?.cancel().catch(() => {});
		file = "poyo";
		response = await requestFeed(file, fetchFeed, signal);
	}
	const feed = await readFeed(file, response, signal);
	const nowMs = now();
	if (!isPricingClock(nowMs)) throw new Error("Local pricing clock is invalid.");
	if (evidenceMs(feed) > nowMs) throw new Error("Pricing feed is dated in the future.");
	const expiresAt = feed.provider === "poyo" ? poyoFeedExpiryMs(feed) : toapisFeedExpiryMs(feed);
	if (nowMs >= expiresAt) throw new Error("Pricing feed has expired.");
	return saveFeed(file, paths[file].cachePath, paths[file].bundledPath, feed, nowMs);
}

/** Describe a refresh with the dates Review uses. */
export function describeRefresh({ status, checkedAt, feed }: RefreshResult): string {
	const checked = `Pricing ${status} at ${checkedAt}.`;
	if (feed.provider === "toapis") return `${checked} Public rates observed ${feed.observedAt}.`;
	const source = `Source ${feed.sourceDate} (${feed.revision}).`;
	const confirmed = feed.version === 2 ? ` Confirmed ${feed.confirmedAt}.` : "";
	const expires = new Date(poyoFeedExpiryMs(feed, Date.parse(checkedAt))).toISOString();
	return `${checked} ${source}${confirmed} Rates expire ${expires}.`;
}

if (import.meta.main) {
	try {
		const { values } = parseArgs({
			args: Bun.argv.slice(2),
			options: { provider: { type: "string", default: "poyo" } },
			strict: true,
		});
		if (!isPricingProvider(values.provider)) throw new Error("Choose --provider poyo or toapis.");
		const result = await refreshPricingFeed({ provider: values.provider });
		console.log(describeRefresh(result));
		console.log(result.cachePath);
	} catch (error) {
		console.error(error instanceof Error ? error.message : "Pricing refresh failed.");
		process.exitCode = 1;
	}
}
