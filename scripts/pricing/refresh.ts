import { randomUUID } from "node:crypto";
import { mkdir, open, realpath, rename, rm, rmdir } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
	isPricingClock,
	parsePricingInstant,
	pricingFeedExpiryMs,
} from "../../src/lib/shared/pricing/feed";
import {
	isPricingProvider,
	type PricingProvider,
	type ProviderPricingFeed,
	pricingSourceDate,
} from "../../src/lib/shared/pricing/feeds";
import { toapisFeedExpiryMs } from "../../src/lib/shared/pricing/toapis-feed";
import {
	type CachedPricingFeed,
	decodeProviderFeed,
	type PricingPaths,
	pricingBundledPath,
	pricingCachePath,
	pricingFeedByteLimit,
	pricingFeedConflict,
	readLocalPricing,
} from "./local-feed";

export const pricingFeedUrl =
	"https://raw.githubusercontent.com/edbfi/siluet/pricing-data/pricing/v1/feed.json";
export const toapisPricingFeedUrl =
	"https://raw.githubusercontent.com/edbfi/siluet/pricing-data-toapis/pricing/v1/toapis.json";
const refreshTimeoutMs = 5_000;

type RefreshOptions = PricingPaths & {
	fetchFeed?: (url: string, init: RequestInit) => Promise<Response>;
	now?: () => number;
	timeoutMs?: number;
};

type RefreshResult = CachedPricingFeed & { status: "updated" | "unchanged"; cachePath: string };

async function readFeed(
	provider: PricingProvider,
	response: Response,
	signal: AbortSignal,
): Promise<ProviderPricingFeed> {
	if (response.status !== 200 || response.redirected || !response.body) {
		void response.body?.cancel().catch(() => {});
		throw new Error(`Pricing feed request failed (HTTP ${response.status}).`);
	}
	if (Number(response.headers.get("content-length")) > pricingFeedByteLimit) {
		void response.body.cancel().catch(() => {});
		throw new Error("Pricing feed exceeds the size limit.");
	}

	const reader = response.body.getReader();
	const cancel = () => {
		void reader.cancel().catch(() => {});
	};
	signal.addEventListener("abort", cancel, { once: true });
	const bytes = new Uint8Array(pricingFeedByteLimit);
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
		feed = decodeProviderFeed(provider, JSON.parse(json));
	} catch {
		throw new Error("Pricing feed is not valid UTF-8 JSON.");
	}
	if (!feed) throw new Error("Pricing feed has an invalid schema.");
	return feed;
}

async function replaceCache(path: string, entry: CachedPricingFeed): Promise<void> {
	const temporary = join(dirname(path), `.feed-${randomUUID()}.tmp`);
	const file = await open(temporary, "wx", 0o600);
	try {
		try {
			await file.writeFile(`${JSON.stringify(entry, null, "\t")}\n`);
			await file.sync();
		} finally {
			await file.close();
		}
		await rename(temporary, path);
	} finally {
		await rm(temporary, { force: true });
	}
}

async function saveFeed(
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
		const { bundled, cache } = await readLocalPricing(bundledPath, cachePath, feed.provider);
		if (!bundled && cache === null) {
			throw new Error("Pricing cache is invalid and the bundled snapshot is unavailable.");
		}
		if (cache && parsePricingInstant(pricingSourceDate(cache.feed)) > nowMs) {
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
		const status = JSON.stringify(feed) === JSON.stringify(previous) ? "unchanged" : "updated";
		const checkedAt = new Date(nowMs).toISOString();
		await replaceCache(cachePath, { checkedAt, feed });
		return { status, checkedAt, feed, cachePath };
	} finally {
		await rmdir(lock);
	}
}

export async function refreshPricingFeed({
	provider = "poyo",
	bundledPath = pricingBundledPath(provider),
	cachePath = pricingCachePath(undefined, provider),
	fetchFeed = fetch,
	now = Date.now,
	timeoutMs = refreshTimeoutMs,
}: RefreshOptions = {}): Promise<RefreshResult> {
	if (resolve(cachePath) === resolve(bundledPath)) {
		throw new Error("Pricing cache and bundled snapshot must use separate paths.");
	}
	const signal = AbortSignal.timeout(timeoutMs);
	const response = await fetchFeed(provider === "poyo" ? pricingFeedUrl : toapisPricingFeedUrl, {
		method: "GET",
		redirect: "error",
		credentials: "omit",
		signal,
	});
	const feed = await readFeed(provider, response, signal);
	const nowMs = now();
	if (!isPricingClock(nowMs)) throw new Error("Local pricing clock is invalid.");
	if (parsePricingInstant(pricingSourceDate(feed)) > nowMs)
		throw new Error("Pricing feed is dated in the future.");
	const expiresAt = feed.provider === "poyo" ? pricingFeedExpiryMs(feed) : toapisFeedExpiryMs(feed);
	if (nowMs >= expiresAt) throw new Error("Pricing feed has expired.");
	return saveFeed(cachePath, bundledPath, feed, nowMs);
}

if (import.meta.main) {
	try {
		const { values } = parseArgs({
			args: Bun.argv.slice(2),
			options: { provider: { type: "string", default: "poyo" } },
			strict: true,
		});
		if (!isPricingProvider(values.provider)) throw new Error("Choose --provider poyo or toapis.");
		const { status, checkedAt, feed, cachePath } = await refreshPricingFeed({
			provider: values.provider,
		});
		const source =
			feed.provider === "poyo"
				? `Source ${feed.sourceDate} (${feed.revision})`
				: `Public rates observed ${feed.observedAt}`;
		console.log(`Pricing ${status} at ${checkedAt}. ${source}.`);
		console.log(cachePath);
	} catch (error) {
		console.error(error instanceof Error ? error.message : "Pricing refresh failed.");
		process.exitCode = 1;
	}
}
