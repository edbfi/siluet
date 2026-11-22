import { parsePricingInstant } from "../../../../src/lib/shared/pricing/feed.ts";
import {
	decodePoyoV2Feed,
	type PoyoPricingFeedV2,
} from "../../../../src/lib/shared/pricing/poyo-feed.ts";
import { normalizeRates, type ReportGap } from "./catalog.ts";

const catalogPath = "artifacts/capability-catalog.json";
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
): Promise<PoyoPricingFeedV2> {
	// This history check is the confirmation, so one clock reading dates both.
	const checkedMs = Math.floor(now() / 1000) * 1000;
	// Filter the default branch history by artifact path and fetch raw files
	// from the resulting commit so provenance and catalog cannot race.
	// https://docs.github.com/en/rest/commits/commits#list-commits
	const commitsUrl = new URL(`https://api.github.com/repos/${upstream}/commits`);
	commitsUrl.search = new URLSearchParams({ path: catalogPath, per_page: "1" }).toString();
	const history = await getText(fetchSource, commitsUrl.href, "catalog history", 64 * 1024, {
		Accept: "application/vnd.github+json",
		"X-GitHub-Api-Version": "2022-11-28",
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
	const rates = normalizeRates(catalog, reportGap);
	const feed = decodePoyoV2Feed({
		version: 2,
		provider: "poyo",
		revision,
		sourceDate,
		confirmedAt,
		rates,
	});
	if (!feed) throw new Error("The normalized PoYo rates failed feed validation.");
	return feed;
}
