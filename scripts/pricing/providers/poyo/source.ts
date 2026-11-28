import {
	canonicalJson,
	poyoFeedSha256,
} from "../../../../src/lib/server/services/pricing/local-feed.ts";
import { parsePricingInstant } from "../../../../src/lib/shared/pricing/feed.ts";
import {
	type PoyoPriceBasis,
	poyoBasisByteLimit,
} from "../../../../src/lib/shared/pricing/poyo-basis.ts";
import {
	decodePoyoV2Feed,
	type PoyoPricingFeedV2,
} from "../../../../src/lib/shared/pricing/poyo-feed.ts";
import { derivedRateKeys, normalizeRates, type ReportGap } from "./catalog.ts";

const catalogPath = "artifacts/capability-catalog.json";
// The workflow hands the pair to the publisher in one environment string, which Linux caps at
// 128 KiB (MAX_ARG_STRLEN). The feed's own blob limit is 64 KiB, as publish.sh applies it.
export const poyoHandoffByteLimit = 120 * 1024;
const feedByteLimit = 64 * 1024;

/** What the collector hands to `publish.sh poyo`: the v2 feed and the basis that pairs with it. */
export type PoyoPricingHandoff = { feed: PoyoPricingFeedV2; basis: PoyoPriceBasis };

const byteLength = (text: string) => new TextEncoder().encode(text).byteLength;
const upstream = "PoyoAPI/poyo-devtools";

type SourceFetch = (url: string, init: RequestInit) => Promise<Response>;

async function getText(
	fetchSource: SourceFetch,
	url: string,
	label: string,
	maxBytes: number,
	headers?: HeadersInit,
): Promise<string> {
	const response = await fetchSource(url, {
		headers,
		redirect: "error",
		signal: AbortSignal.timeout(20_000),
	});
	if (!response.ok || !response.body) {
		throw new Error(`PoYo ${label} fetch failed (HTTP ${response.status}).`);
	}
	const reader = response.body.getReader();
	const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
	let bytes = 0;
	let text = "";
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) return text + decoder.decode();
			bytes += value.byteLength;
			if (bytes > maxBytes) throw new Error(`PoYo ${label} exceeds the size limit.`);
			text += decoder.decode(value, { stream: true });
		}
	} catch (error) {
		await reader.cancel().catch(() => {});
		throw error;
	} finally {
		reader.releaseLock();
	}
}

export async function collectPoyoPricing(
	fetchSource: SourceFetch,
	expectedLicense: string,
	reportGap?: ReportGap,
	now: () => number = Date.now,
	githubToken = "",
	derivedKeys: readonly string[] = derivedRateKeys,
): Promise<PoyoPricingHandoff> {
	// This history check is the confirmation, so one clock reading dates both.
	const checkedMs = Math.floor(now() / 1000) * 1000;
	// Filter the default branch history by artifact path and fetch raw files
	// from the resulting commit so provenance and catalog cannot race.
	// https://docs.github.com/en/rest/commits/commits#list-commits
	const commitsUrl = new URL(`https://api.github.com/repos/${upstream}/commits`);
	commitsUrl.search = new URLSearchParams({ path: catalogPath, per_page: "1" }).toString();
	// Anonymous REST calls share a small per-IP limit on hosted runners, so CI
	// authenticates this one request. Raw file downloads stay anonymous.
	// https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api
	const history = await getText(fetchSource, commitsUrl.href, "catalog history", 64 * 1024, {
		Accept: "application/vnd.github+json",
		"X-GitHub-Api-Version": "2022-11-28",
		...(githubToken ? { Authorization: `Bearer ${githubToken}` } : {}),
	});
	const commits: unknown = JSON.parse(history);
	const revision: unknown = Array.isArray(commits) ? commits[0]?.sha : undefined;
	const sourceDate: unknown = Array.isArray(commits)
		? commits[0]?.commit?.committer?.date
		: undefined;
	const commitTime = parsePricingInstant(sourceDate);
	if (
		!Array.isArray(commits) ||
		commits.length !== 1 ||
		typeof revision !== "string" ||
		!/^[a-f0-9]{40}$/.test(revision) ||
		typeof sourceDate !== "string" ||
		!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(sourceDate) ||
		!Number.isFinite(commitTime)
	) {
		throw new Error("Invalid PoYo catalog commit provenance.");
	}

	if (!Number.isFinite(checkedMs) || commitTime > checkedMs) {
		throw new Error("The PoYo catalog commit date is in the future.");
	}
	const confirmedAt = new Date(checkedMs).toISOString().replace(".000Z", "Z");

	const rawBase = `https://raw.githubusercontent.com/${upstream}/${revision}/`;
	const catalog = await getText(fetchSource, rawBase + catalogPath, "catalog", 4 * 1024 * 1024);
	const license = await getText(fetchSource, `${rawBase}LICENSE`, "license", 8 * 1024);
	if (license !== expectedLicense) throw new Error("The upstream PoYo license changed.");
	const { rates, digests } = normalizeRates(catalog, reportGap, derivedKeys);
	const feed = decodePoyoV2Feed({
		version: 2,
		provider: "poyo",
		revision,
		sourceDate,
		confirmedAt,
		rates,
	});
	if (!feed) throw new Error("The normalized PoYo rates failed feed validation.");
	const basis = { revision: feed.revision, feedSha256: poyoFeedSha256(feed), digests };
	if (byteLength(JSON.stringify({ feed, basis })) > poyoHandoffByteLimit)
		throw new Error("The PoYo pricing handoff exceeds 120 KiB.");
	// Published blobs carry a trailing LF.
	if (byteLength(canonicalJson(feed)) + 1 > feedByteLimit)
		throw new Error("The PoYo pricing feed exceeds 64 KiB.");
	if (byteLength(canonicalJson(basis)) + 1 > poyoBasisByteLimit)
		throw new Error("The PoYo price basis exceeds 32 KiB.");
	return { feed, basis };
}
