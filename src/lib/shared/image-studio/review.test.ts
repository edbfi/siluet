import { expect, test } from "bun:test";
import { toapisRates } from "../../../../tests/fixtures/toapis-feed";
import type { PricingFeed } from "../pricing/feed";
import { decodePricingFeeds } from "../pricing/feeds";
import { createImageReview, type ReviewReference } from "./review";
import {
	estimateReviewPrice,
	maximumReviewAttempts,
	reviewPriceExpiry,
	reviewPriceReason,
	watchReviewExpiry,
} from "./review-price";

const references: readonly ReviewReference[] = [
	{
		kind: "url",
		url: "https://cdn.example.test/private?a=reference-secret",
		hostname: "cdn.example.test",
	},
	{ kind: "file", file: new File(["media-secret"], "local/path/art.png", { type: "image/png" }) },
	{ kind: "url", url: "http://other.example.test/private/b", hostname: "other.example.test" },
];
const input = { provider: "poyo", operation: "edit", references } as const;
const poyoWire = {
	method: "POST",
	url: "https://api.poyo.ai/api/generate/submit",
	body: {
		model: "seedream-5.5",
		input: {
			prompt:
				'Paint in blue using "https://assets.example.test/?token=prompt-secret" and HTTPS://private.example.test/photo',
			size: "auto",
			resolution: "2K",
			background: "auto",
			enable_safety_checker: false,
			output_format: "png",
			image_urls: [
				references[0].kind === "url" ? references[0].url : "",
				"blob:media-secret",
				"http://other.example.test/private/b",
			],
		},
	},
} as const;
const toapisInput = { provider: "toapis", operation: "generate", references: [] } as const;
const toapisWire = {
	method: "POST",
	url: "https://toapis.com/v1/images/generations",
	body: {
		model: "doubao-seedream-5-5",
		prompt: "Tiles from <https://private.example.test/sample> by the sea",
		size: "1K",
		disable_nsfw: false,
		metadata: { background: "auto", watermark: false, output_format: "png" },
	},
} as const;
const poyoFeed = {
	version: 1,
	provider: "poyo",
	revision: "a".repeat(40),
	sourceDate: "2026-11-19T13:27:00Z",
	rates: {
		"z-image": { kind: "unavailable" },
		"seedream-5.5": {
			kind: "per-image-with-references",
			resolutions: { "1K": "4", "1.5K": "4", "2K": "7" },
			perReference: "1.6",
		},
	},
} satisfies PricingFeed;
const feeds = decodePricingFeeds({ poyo: poyoFeed, toapis: toapisRates });
const now = Date.parse("2026-11-22T00:00:00Z");

test("Review preserves the Poyo wire shape and the order of local file and URL descriptions", () => {
	const review = createImageReview(input, poyoWire);
	expect(review.sources).toEqual([
		{ kind: "url", label: "cdn.example.test" },
		{ kind: "file", label: "art.png" },
		{ kind: "url", label: "other.example.test" },
	]);
	expect(review.outgoing).toEqual({
		method: "POST",
		url: poyoWire.url,
		body: {
			model: "seedream-5.5",
			input: {
				prompt: 'Paint in blue using "[URL hidden]" and [URL hidden]',
				size: "auto",
				resolution: "2K",
				background: "auto",
				enable_safety_checker: false,
				output_format: "png",
				image_urls: ["[remote URL hidden]", "[local image]", "[remote URL hidden]"],
			},
		},
	});
	expect(review.pricing).toEqual({
		provider: "poyo",
		model: "seedream-5.5",
		operation: "edit",
		options: {
			size: "auto",
			resolution: "2K",
			background: "auto",
			enable_safety_checker: false,
			output_format: "png",
		},
		sourceCount: 3,
	});
	expect(JSON.stringify(review)).not.toMatch(
		/reference-secret|prompt-secret|media-secret|local\/path|private\.example/,
	);
	expect(poyoWire.body.input.prompt).toContain("prompt-secret");
});

test("Review retains ToAPIs top-level fields and generation omits references", () => {
	const review = createImageReview(toapisInput, toapisWire);
	expect(review.sources).toEqual([]);
	expect(review.outgoing.body).toEqual({
		...toapisWire.body,
		prompt: "Tiles from <[URL hidden]> by the sea",
	});
	expect(review.pricing).toEqual({
		provider: "toapis",
		model: "doubao-seedream-5-5",
		operation: "generate",
		sourceCount: 0,
		options: {
			size: "1K",
			disable_nsfw: false,
			metadata: { background: "auto", watermark: false, output_format: "png" },
		},
	});
});

test("Review redacts credential-bearing, protocol-relative, and local media URLs inside prompt text", () => {
	const review = createImageReview(toapisInput, {
		...toapisWire,
		body: {
			...toapisWire.body,
			prompt:
				"See https://name:credential@cdn.test/x and //host.test/private; try <file:///private/name>, <blob:https://host.test/id> and <data:image/png;base64,AA>.",
		},
	});
	expect(review.outgoing.body).toMatchObject({
		prompt:
			"See [URL hidden] and [URL hidden]; try <[URL hidden]>, <[URL hidden]> and <[URL hidden]>.",
	});
});

test("Review hides signed links in prompt prose and preserves the submitted prompt", () => {
	const prompt = `Use 'https://assets.test/artist's/image?token=secret1', www.assets.test/x?token=secret2, and assets.test:8443/x?token=secret3. Compare <//:password@assets.test/x> with <ftp://:password@assets.test/x>. Keep art.png.`;
	const request = { ...toapisWire, body: { ...toapisWire.body, prompt } };
	const review = createImageReview(toapisInput, request);
	expect(review.outgoing.body).toMatchObject({
		prompt:
			"Use '[URL hidden]', [URL hidden] and [URL hidden] Compare <[URL hidden]> with <[URL hidden]>. Keep art.png.",
	});
	expect(request.body.prompt).toBe(prompt);
});

test.each([
	"assets.xn--p1ai/image?token=private",
	"assets.भारत/render?token=private",
	"assets.example./image?token=private",
	"user:private@assets.test/image",
	"user:@assets.test_1/private?token=private",
	"user:@assets.test_1?token=private",
	"user:@assets.test_1#private",
	"user:@assets.test_1:8080",
	"user:private@assets.test",
	"10.0.0.5:8080/image?token=private",
	"[::1]:8080/image?token=private",
	"localhost:3000/image?token=private",
	"studio:8080/image?token=private",
])("Review hides a signed or credential-bearing host reference (%#)", (url) => {
	const request = { ...toapisWire, body: { ...toapisWire.body, prompt: `Read <${url}> in blue.` } };
	expect(createImageReview(toapisInput, request).outgoing.body).toMatchObject({
		prompt: "Read <[URL hidden]> in blue.",
	});
});

test.each([
	["[user:private@assets.test]", "[[URL hidden]]"],
	["Credits:@artist.studio_1…", "Credits:@artist.studio_1…"],
	["*Credits:@artist.studio_1*", "*Credits:@artist.studio_1*"],
	["“user:private@assets.test”", "“[URL hidden]”"],
	["‘user:private@assets.test’", "‘[URL hidden]’"],
	["«user:private@assets.test»", "«[URL hidden]»"],
	["user:pw@assets.test—", "[URL hidden]—"],
	["*user:pw@assets.test*", "*[URL hidden]*"],
	["user:@assets.test", "[URL hidden]"],
	["user:@[::1]", "[URL hidden]"],
	["https://[::1].", "[URL hidden]."],
	["[https://user:private@[::1]]", "[[URL hidden]]"],
	["//[::1]", "[URL hidden]"],
	["https://assets.test/media?token=---", "[URL hidden]"],
	["assets.test/media?token=***", "[URL hidden]"],
	["https://assets.test/media?token=...", "[URL hidden]"],
	["https://assets.test/media?token=--.!", "[URL hidden]"],
	["https://assets.test/media#private...", "[URL hidden]"],
	["“https://assets.test/media?token=..!”", "“[URL hidden]”"],
	["user:pw@assets.test’s", "[URL hidden]"],
	["user:private@assets.test_1", "[URL hidden]"],
	['Print "Credits:@artist.studio_1" in gold.', 'Print "Credits:@artist.studio_1" in gold.'],
	["user:private@[::1].", "[URL hidden]."],
	["(user:private@studio:8080)", "([URL hidden])"],
	['Print "Credits:@artist" in gold.', 'Print "Credits:@artist" in gold.'],
])("Review distinguishes a credentialed link from a literal label (%#)", (prompt, expected) => {
	const request = { ...toapisWire, body: { ...toapisWire.body, prompt } };
	expect(createImageReview(toapisInput, request).outgoing.body).toMatchObject({ prompt: expected });
	expect(request.body.prompt).toBe(prompt);
});

test("Review keeps aspect ratios, times, scales and versions visible", () => {
	const prompt =
		"2.39:1 or 1.85:1 at 12:30? Scale 1.5/2, 4:3/16:9, v1.2/ beta, e.g./i.e. Use 16:9@4K or 1:1@2x.";
	const request = { ...toapisWire, body: { ...toapisWire.body, prompt } };
	expect(createImageReview(toapisInput, request).outgoing.body).toMatchObject({ prompt });
});

test("reviewed request options price the initial batch and attempts count includes retries", () => {
	const review = createImageReview(input, poyoWire);
	expect(
		estimateReviewPrice(feeds, review.pricing, { count: 2, retryLimit: 1 }, now),
	).toMatchObject({
		status: "known",
		unit: "poyo_credit",
		perRequest: "11.8",
		batch: "23.6",
		maxAttempts: 4,
		sourceDate: poyoFeed.sourceDate,
	});
	expect(maximumReviewAttempts({ count: 1, retryLimit: 0 })).toBe(1);
	expect(maximumReviewAttempts({ count: 5, retryLimit: 3 })).toBe(20);
});

test("ToAPIs price uses the exact tier and stays unknown with unpriced options", () => {
	const estimate = (size: string) => {
		const review = createImageReview(toapisInput, {
			...toapisWire,
			body: { ...toapisWire.body, size },
		});
		return estimateReviewPrice(feeds, review.pricing, { count: 2, retryLimit: 3 }, now);
	};
	expect(estimate("1K")).toMatchObject({
		status: "known",
		unit: "toapis_credit",
		perRequest: "3.2",
		batch: "6.4",
		maxAttempts: 8,
		sourceDate: toapisRates.observedAt,
	});
	const estimateForPixels = estimate("2048x2048");
	expect(estimateForPixels).toEqual({
		status: "unknown",
		reason: "unsupported-input",
		maxAttempts: 8,
	});
	expect(reviewPriceReason(estimateForPixels)).toContain("options");
});

test("Review explains missing or expired evidence and retains a verified usage-based unit rate", () => {
	const review = createImageReview(toapisInput, toapisWire);
	const batch = { count: 5, retryLimit: 3 };
	const missing = estimateReviewPrice({}, review.pricing, batch, now);
	expect(missing).toEqual({ status: "unknown", reason: "missing-feed", maxAttempts: 20 });
	expect(reviewPriceReason(missing)).toContain("local rate");
	const expiry = reviewPriceExpiry(estimateReviewPrice(feeds, review.pricing, batch, now));
	expect(expiry).toBe(Date.parse(toapisRates.observedAt) + 30 * 24 * 60 * 60 * 1000);
	if (expiry === undefined) throw new Error("Expected rate expiry");
	expect(estimateReviewPrice(feeds, review.pricing, batch, expiry - 1).status).toBe("known");
	const expired = estimateReviewPrice(feeds, review.pricing, batch, expiry);
	expect(expired).toEqual({ status: "unknown", reason: "expired-feed", maxAttempts: 20 });
	expect(reviewPriceReason(expired)).toContain("30 days");

	const usage = estimateReviewPrice(
		feeds,
		{
			provider: "toapis",
			model: "seedance-2-5",
			operation: "generate",
			options: {},
			sourceCount: 0,
		},
		batch,
		now,
	);
	expect(usage).toMatchObject({
		status: "unknown",
		reason: "token-usage-unknown",
		advertisedUnitRate: { approximateCredits: "2000", unit: "million-total-tokens" },
	});
	expect(reviewPriceExpiry(usage)).toBe(expiry);
	expect(reviewPriceReason(usage)).toContain("token usage");
});

test("the open Review clock refreshes at the evidence boundary, including beyond the timer limit", () => {
	let current = now;
	let runTimer: (() => void) | undefined;
	let delay = 0;
	const checked: number[] = [];
	const maxDelay = 2_147_483_647;
	const expiry = now + maxDelay + 1000;
	const watch = watchReviewExpiry(expiry, (time) => checked.push(time), {
		now: () => current,
		schedule(callback, milliseconds) {
			runTimer = callback;
			delay = milliseconds;
			return () => {
				runTimer = undefined;
			};
		},
	});
	expect(delay).toBe(maxDelay);
	current += delay;
	runTimer?.();
	expect(delay).toBe(1000);
	current += delay;
	runTimer?.();
	expect(checked.at(-1)).toBe(expiry);
	watch.stop();
	expect(runTimer).toBeUndefined();
});

test("rechecking a suspended Review re-arms the timer from the current wall clock", () => {
	const expiry = now + 10_000;
	let current = now;
	let delay = 0;
	let cancelled = 0;
	const watch = watchReviewExpiry(expiry, () => {}, {
		now: () => current,
		schedule(_callback, milliseconds) {
			delay = milliseconds;
			return () => {
				cancelled++;
			};
		},
	});
	expect(delay).toBe(10_000);
	current = expiry - 500;
	watch.refresh();
	expect(cancelled).toBe(1);
	expect(delay).toBe(500);
	watch.stop();
	expect(cancelled).toBe(2);
});
