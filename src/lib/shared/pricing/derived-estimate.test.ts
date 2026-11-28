import { expect, test } from "bun:test";
import pair from "../../../../tests/fixtures/poyo-basis-pair.json";
import { createDerivedDraft } from "../image-studio/derived";
import { queueRows } from "../media-catalog/image-queue";
import type { QueueRow } from "../media-catalog/queue-row";
import { estimateDerivedPrice } from "./derived-estimate";
import { estimatePrice } from "./estimate";
import { decodePricingFeed, pricingMaxAgeMs } from "./feed";
import type { PricingFeeds } from "./feeds";
import { decodePoyoBasis } from "./poyo-basis";
import { decodePoyoV2Feed, type PoyoPricingFeedV2 } from "./poyo-feed";

const feed = decodePoyoV2Feed(pair.feed) as PoyoPricingFeedV2;
const basis = decodePoyoBasis(pair.basis);
if (!feed || !basis) throw new Error("The basis fixture does not decode.");
const feeds: PricingFeeds = { poyo: feed, poyoBasis: basis };
const now = Date.parse(feed.confirmedAt) + 1000;
const expiresAt = new Date(Date.parse(feed.confirmedAt) + pricingMaxAgeMs).toISOString();

function row(model: string): QueueRow {
	const found = queueRows.find(({ rateKey }) => rateKey === model);
	if (!found) throw new Error(`${model} is not a queue row.`);
	return found;
}
const options = (target: QueueRow, changes: Record<string, unknown> = {}) => ({
	...createDerivedDraft(target).options,
	...changes,
});
const quote = (target: QueueRow, changes?: Record<string, unknown>, at = now, from = feeds) =>
	estimateDerivedPrice(from, target, options(target, changes), at);
const known = (perRequest: string) => ({
	status: "known",
	unit: "poyo_credit",
	perRequest,
	batch: perRequest,
	maxAttempts: 1,
	sourceDate: feed.sourceDate,
	revision: feed.revision,
	expiresAt,
});
const unknown = (reason: string) => ({ status: "unknown", reason, maxAttempts: 1 });

test("a derived row quotes its exact rate while the basis binds the row's own digest", () => {
	expect<unknown>(quote(row("gpt-4o-image"))).toEqual(known("4"));
	expect<unknown>(quote(row("flux-3-klein"), { resolution: "1K" })).toEqual(known("1.8"));
	expect<unknown>(quote(row("flux-3-klein"), { resolution: "2K" })).toEqual(known("2.8"));
	expect<unknown>(quote(row("kling-o3-image"), { resolution: "2K" })).toEqual(known("3.5"));
});

test("a tier matches case-insensitively and after the collector's key normalisation", () => {
	const tiers = (
		resolutions: Record<string, string>,
		values: string[],
	): [QueueRow, PricingFeeds] => {
		const target: QueueRow = {
			...row("kling-o3-image"),
			fields: [{ wire: "resolution", kind: "enum", values, preselect: values[0] }],
		};
		const rates = {
			...feed.rates,
			"kling-o3-image": { kind: "per-request-by-resolution", resolutions },
		};
		return [target, { ...feeds, poyo: { ...feed, rates } as PoyoPricingFeedV2 }];
	};
	const [upper, upperFeeds] = tiers({ "1080P": "5" }, ["1080p"]);
	expect<unknown>(quote(upper, {}, now, upperFeeds)).toEqual(known("5"));
	const [star, starFeeds] = tiers({ "480x832": "2" }, ["480*832"]);
	expect<unknown>(quote(star, {}, now, starFeeds)).toEqual(known("2"));
	const [other, otherFeeds] = tiers({ "1K": "2" }, ["2K"]);
	expect<unknown>(quote(other, {}, now, otherFeeds)).toEqual(unknown("unsupported-input"));
});

test("an unpaired, missing or unbound basis makes the derived rate unknown while verified rates quote", () => {
	const target = row("gpt-4o-image");
	const another = { ...basis, revision: "f".repeat(40) };
	const unbound = { ...basis, digests: { ...basis.digests, "gpt-4o-image": "f".repeat(64) } };
	const v1 = decodePricingFeed({
		version: 1,
		provider: "poyo",
		revision: feed.revision,
		sourceDate: feed.sourceDate,
		rates: { "z-image": feed.rates["z-image"], "seedream-5.5": feed.rates["seedream-5.5"] },
	});
	const cases: [PricingFeeds, string][] = [
		[{ poyo: feed }, "rate-unavailable"],
		[{ poyo: feed, poyoBasis: another }, "rate-unavailable"],
		[{ poyo: feed, poyoBasis: unbound }, "rate-unavailable"],
		[{ poyo: v1, poyoBasis: basis }, "rate-unavailable"],
		[{ poyoBasis: basis }, "missing-feed"],
	];
	for (const [from, reason] of cases) {
		expect<unknown>(quote(target, {}, now, from)).toEqual(unknown(reason));
		const zImage = {
			provider: "poyo",
			model: "z-image",
			operation: "generate",
			options: { size: "1:1" },
			sourceCount: 0,
			count: 1,
			retryLimit: 0,
		};
		if (from.poyo) expect(estimatePrice(from.poyo, zImage, now)).toMatchObject({ status: "known" });
	}
});

test("a gap, an expired feed and a clock before the source each stay unknown", () => {
	expect<unknown>(quote(row("flux-dev"))).toEqual(unknown("rate-unavailable"));
	expect<unknown>(quote(row("gpt-4o-image"), {}, Date.parse(expiresAt))).toEqual(
		unknown("expired-feed"),
	);
	expect<unknown>(quote(row("gpt-4o-image"), {}, Date.parse(feed.sourceDate) - 1)).toEqual(
		unknown("invalid-clock"),
	);
});
