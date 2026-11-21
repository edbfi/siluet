import { expect, test } from "bun:test";
import { collectToapisPricing } from "./source.ts";

const pricingUrl = "https://toapis.com/pricing";
const imageUrl = "https://toapis.com/model-guide/doubao-seedream-5-5";
const videoUrl = "https://toapis.com/model-guide/seedance-2-5";
const observed = new Date("2026-11-21T15:00:00.123Z");

function page(url: string, body: string): string {
	return `<!doctype html><html><head><link rel="canonical" href="${url}"></head><body><main>${body}</main></body></html>`;
}

const pricing = page(pricingUrl, '<a href="/dashboard/billing">1 credit ≈ $0.005</a>');
const images = page(
	imageUrl,
	`<h1>Seedream 5.5</h1>
	<table><thead><tr><th>Specification</th><th>ToAPIs price</th><th>Savings</th><th>ByteDance official list</th></tr></thead><tbody>
	<tr><td>1K / 1.5K</td><td><b>ToAPIs</b><span>$0.014125</span><span>image</span></td><td>30%</td><td>$0.02</td></tr>
	<tr><td>2K</td><td>ToAPIs $0.027 image</td><td>23%</td><td>$0.035</td></tr>
	</tbody></table>`,
);
const videos = page(
	videoUrl,
	`<h1>Seedance 2.5</h1>
	<table><thead><tr><th>Specification</th><th>ToAPIs price</th><th>Billing basis</th></tr></thead><tbody>
	<tr><td>No video input</td><td>ToAPIs $11 1M total tokens</td><td>1M total tokens</td></tr>
	<tr><td>With video input</td><td>ToAPIs $7.5 1M total tokens</td><td>1M total tokens</td></tr>
	</tbody></table>`,
);

function html(body: string, headers: HeadersInit = {}): Response {
	return new Response(body, {
		headers: { "Content-Type": "text/html; charset=utf-8", ...headers },
	});
}

test("collects only advertised model rates and preserves source scope, units, conditions and age", async () => {
	const requested: string[] = [];
	const feed = await collectToapisPricing((url, init) => {
		requested.push(url);
		expect(init.method).toBe("GET");
		expect(init.credentials).toBe("omit");
		expect(init.redirect).toBe("error");
		expect(new Headers(init.headers).get("cookie")).toBeNull();
		expect(new Headers(init.headers).get("authorization")).toBeNull();
		expect(init.signal).toBeInstanceOf(AbortSignal);
		switch (url) {
			case pricingUrl:
				return Promise.resolve(html(pricing, { Age: "15" }));
			case imageUrl:
				return Promise.resolve(html(images, { Age: "3600" }));
			case videoUrl:
				return Promise.resolve(html(videos));
			default:
				throw new Error("Unexpected request.");
		}
	}, observed);
	expect(requested).toEqual([pricingUrl, imageUrl, videoUrl]);
	expect(feed).toMatchObject({
		version: 1,
		provider: "toapis",
		observedAt: "2026-11-21T15:00:00Z",
		creditsPerUsd: "200",
		conversionSourceUrl: pricingUrl,
		conversionCacheAgeSeconds: 15,
	});
	expect(feed.rates).toEqual([
		...(
			[
				["1K", "0.014125", "2.825"],
				["1.5K", "0.014125", "2.825"],
				["2K", "0.027", "5.4"],
			] as const
		).map(
			([size, usd, approximateCredits]) =>
				({
					model: "doubao-seedream-5-5",
					operations: ["generate", "edit"],
					unit: "image",
					conditions: { size, outputCount: 1, layerDecomposition: false },
					usd,
					approximateCredits,
					source: {
						url: imageUrl,
						scope: "public-advertised",
						region: "global-site",
						tier: null,
						publishedAt: null,
						cacheAgeSeconds: 3600,
					},
				}) as const,
		),
		...[false, true].map(
			(videoInput) =>
				({
					model: "seedance-2-5",
					operations: ["generate", "edit"],
					unit: "million-total-tokens",
					conditions: { videoInput },
					usd: videoInput ? "7.5" : "11",
					approximateCredits: videoInput ? "1500" : "2200",
					source: {
						url: videoUrl,
						scope: "public-advertised",
						region: "global-site",
						tier: null,
						publishedAt: null,
						cacheAgeSeconds: null,
					},
				}) as const,
		),
	]);
	expect(feed.gaps).toEqual([
		{ model: "doubao-seedream-5-5", reason: "unpriced-image-options" },
		{ model: "seedance-2-5", reason: "token-usage-unknown" },
	]);
});

test.each([302, 403, 429])(
	"stops on HTTP %i without retrying or fetching more pages",
	async (status) => {
		let requests = 0;
		await expect(
			collectToapisPricing(() => {
				requests++;
				return Promise.resolve(new Response("response body", { status }));
			}, observed),
		).rejects.toThrow(`HTTP ${status}`);
		expect(requests).toBe(1);
	},
);

test("rejects a challenge even if it returns HTTP 200", async () => {
	await expect(
		collectToapisPricing(
			() => Promise.resolve(html(pricing, { "cf-mitigated": "challenge" })),
			observed,
		),
	).rejects.toThrow("challenge");
});

test.each([
	["conversion changed", pricing.replace("0.005", "0.01"), "credit conversion"],
	["wrong canonical", pricing.replace(pricingUrl, imageUrl), "canonical URL"],
	["challenge HTML", "<html><title>Just a moment...</title></html>", "canonical URL"],
	["invalid cache age", pricing, "cache age"],
])("rejects %s", async (reason, body, message) => {
	await expect(
		collectToapisPricing(
			() => Promise.resolve(html(body, reason === "invalid cache age" ? { Age: "-1" } : {})),
			observed,
		),
	).rejects.toThrow(message);
});

test("enforces the decoded body limit without relying on Content-Length", async () => {
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(new Uint8Array(400 * 1024));
			controller.enqueue(new Uint8Array(400 * 1024));
			controller.close();
		},
	});
	await expect(
		collectToapisPricing(
			() => Promise.resolve(new Response(body, { headers: { "Content-Type": "text/html" } })),
			observed,
		),
	).rejects.toThrow("size limit");
});

test.each([
	["zero", images.replace("$0.027", "$0")],
	["credit overflow", images.replace("$0.027", "$999999999999")],
	["wrong unit", images.replace("$0.027 image", "$0.027 / req")],
	["unspecified range", images.replace("$0.027", "$0.02–0.03")],
	["duplicate tier", images.replace(">2K<", ">1K / 1.5K<")],
	["missing tier", images.replace(">2K<", ">4K<")],
	["wrong price column", images.replace("<th>ToAPIs price</th>", "<th>ByteDance price</th>")],
	["wrong model identity", images.replace("<h1>Seedream 5.5", "<h1>Seedream 5.0")],
])("rejects %s in advertised image rows", async (_description, body) => {
	await expect(
		collectToapisPricing(
			(url) => Promise.resolve(html(url === pricingUrl ? pricing : body)),
			observed,
		),
	).rejects.toThrow("Seedream");
});

test("does not accept another response format", async () => {
	await expect(
		collectToapisPricing(() => Promise.resolve(new Response("{}")), observed),
	).rejects.toThrow("HTML");
});

test("rejects a snapshot with an impossible page cache age", async () => {
	const pages = new Map([
		[pricingUrl, pricing],
		[imageUrl, images],
		[videoUrl, videos],
	]);
	await expect(
		collectToapisPricing(
			async (url) => html(pages.get(url) ?? "", { Age: "9007199254740991" }),
			observed,
		),
	).rejects.toThrow();
});

test("sequential GETs preserve each source receipt time", async () => {
	const pages = new Map([
		[pricingUrl, pricing],
		[imageUrl, images],
		[videoUrl, videos],
	]);
	let ms = observed.getTime();
	const feed = await collectToapisPricing(
		async (url) => {
			ms += 2000;
			return html(pages.get(url) ?? "", { Age: "1" });
		},
		() => new Date(ms),
	);
	expect([
		feed.conversionCacheAgeSeconds,
		...feed.rates.map((row) => row.source.cacheAgeSeconds),
	]).toEqual([5, 3, 3, 3, 1, 1]);
});
