import { expect, test } from "bun:test";
import { toapisEffectiveObservations } from "../../../../src/lib/shared/pricing/toapis-feed";
import { collectToapisPricing } from "./source.ts";

const pricingUrl = "https://toapis.com/pricing";
const imageUrl = "https://toapis.com/model-guide/doubao-seedream-5-5";
const videoUrl = "https://toapis.com/model-guide/seedance-2-5";
const observed = new Date("2026-11-21T15:00:00.123Z");

function page(url: string, body: string, scripts = ""): string {
	return `<!doctype html><html><head><link rel="canonical" href="${url}"></head><body><main>${body}</main>${scripts}</body></html>`;
}

const pricing = page(pricingUrl, '<a href="/dashboard/billing">1 credit ≈ $0.005</a>');

// The 2026-11-24 model guide wraps each price cell in paragraphs.
const cell = (...lines: string[]) =>
	`<td><div>${lines.map((line) => `<p>${line}</p>`).join("")}</div></td>`;
const row = (label: string, price: string, savings: string, official: string) =>
	`<tr><td><div><span></span><span>${label}</span></div></td>${cell("ToAPIs", price, "image")}<td><span>${savings}</span></td>${cell("ByteDance official list", official, "image")}</tr>`;
const rows = {
	small: row("1K / 1.5K", "$0.014125", "Save 30%", "$0.02"),
	large: row("2K", "$0.027", "Save 23%", "$0.035"),
	input: row("Image input", "$0.0056", "-", "-"),
};
const note = (amount: string) =>
	`<p>Ordinary generation returns one image; layer decomposition returns a base image and PNG layers. Reference images are billed at $${amount} per image. Billing settles when the task completes.</p>`;
// The page embeds its pricing data in a Next.js flight string, so the JSON arrives escaped.
const flight = (data: string) =>
	`<script>self.__next_f.push([1,${JSON.stringify(`1a:{"heroPricing":{"variants":[{"modelId":"doubao-seedream-5-5","tiers":[{"label":"2K","usd":0.027,"unitLabel":"image"}],${data}}]}}\n`)}])</script>`;
const inputImage = '"inputImage":{"usd":0.0056,"freeCount":0}';
const imagePage = ({
	body = Object.values(rows).join(""),
	text = note("0.0056"),
	scripts = `<script>self.__next_f.push([1])</script>${flight(inputImage)}`,
} = {}) =>
	page(
		imageUrl,
		`<h1>Seedream 5.5</h1>
	<table><thead><tr><th>Specification</th><th>ToAPIs price</th><th>Savings</th><th>ByteDance official list</th></tr></thead><tbody>
	${body}
	</tbody></table>${text}`,
		scripts,
	);
const images = imagePage();
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
		version: 2,
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
		{
			model: "doubao-seedream-5-5",
			operations: ["generate", "edit"],
			unit: "reference-image",
			conditions: { freeAllowance: 0 },
			usd: "0.0056",
			approximateCredits: "1.12",
			source: {
				url: imageUrl,
				scope: "public-advertised",
				region: "global-site",
				tier: null,
				publishedAt: null,
				cacheAgeSeconds: 3600,
			},
		},
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
	["wrong unit", images.replace("<p>$0.027</p><p>image</p>", "<p>$0.027</p><p>/ req</p>")],
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

test.each([
	["the old two-row table", imagePage({ body: rows.small + rows.large }), "pricing table"],
	["a fourth row", imagePage({ body: Object.values(rows).join("") + rows.input }), "pricing table"],
	["reordered rows", imagePage({ body: rows.large + rows.small + rows.input }), "pricing table"],
	[
		"an input row with savings",
		imagePage({ body: rows.small + rows.large + row("Image input", "$0.0056", "Save 20%", "-") }),
		"image input row",
	],
	[
		"an input row with an official price",
		imagePage({ body: rows.small + rows.large + row("Image input", "$0.0056", "-", "$0.008") }),
		"image input row",
	],
	[
		"an input row with another unit",
		imagePage({
			body: rows.small + rows.large + rows.input.replace("<p>image</p>", "<p>request</p>"),
		}),
		"advertised price or unit",
	],
	["a missing reference note", imagePage({ text: "" }), "billing note"],
	[
		"a duplicated reference note",
		imagePage({ text: note("0.0056") + note("0.0056") }),
		"billing note",
	],
	["a note amount mismatch", imagePage({ text: note("0.0064") }), "prices disagree"],
	[
		"free-allowance wording",
		imagePage({
			text: note("0.0056").replace(
				"Reference images are billed",
				"The first reference image is free. Further reference images are billed",
			),
		}),
		"billing note",
	],
	[
		"a separate free-allowance note",
		imagePage({ text: `${note("0.0056")}<p>Your first reference image each day is free.</p>` }),
		"billing note",
	],
	[
		"a missing inputImage entry",
		imagePage({ scripts: flight('"other":{}') }),
		"page data has changed",
	],
	[
		"a duplicated inputImage entry",
		imagePage({ scripts: flight(inputImage) + flight(inputImage) }),
		"page data has changed",
	],
	[
		"an inputImage amount mismatch",
		imagePage({ scripts: flight('"inputImage":{"usd":0.0064,"freeCount":0}') }),
		"prices disagree",
	],
	[
		"a changed freeCount",
		imagePage({ scripts: flight('"inputImage":{"usd":0.0056,"freeCount":1}') }),
		"prices disagree",
	],
	[
		"an inputImage with more fields",
		imagePage({ scripts: flight('"inputImage":{"usd":0.0056,"freeCount":0,"tiers":[]}') }),
		"page data has changed",
	],
	[
		"an unescaped inputImage outside the flight data",
		imagePage({ scripts: `<script>window.pricing={${inputImage}}</script>` }),
		"page data has changed",
	],
	[
		"an unescaped inputImage next to the flight data",
		imagePage({ scripts: `${flight(inputImage)}<script>window.pricing={${inputImage}}</script>` }),
		"page data has changed",
	],
	[
		"an unreadable flight string",
		imagePage({ scripts: `${flight(inputImage)}<script>self.__next_f.push([1,"\\x"])</script>` }),
		"Unreadable",
	],
] as const)("rejects %s on the Seedream page", async (_description, body, message) => {
	await expect(
		collectToapisPricing(
			(url) => Promise.resolve(html(url === pricingUrl ? pricing : body)),
			observed,
		),
	).rejects.toThrow(message);
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

test.each([1, null])(
	"sequential GETs preserve reported Age %s and each receipt time",
	async (age) => {
		const pages = new Map([
			[pricingUrl, pricing],
			[imageUrl, images],
			[videoUrl, videos],
		]);
		let ms = observed.getTime();
		const feed = await collectToapisPricing(
			async (url) => {
				ms += 2000;
				return html(pages.get(url) ?? "", age === null ? {} : { Age: String(age) });
			},
			() => new Date(ms),
		);
		expect(feed.conversionCacheAgeSeconds).toBe(age);
		for (const rate of feed.rates) expect(rate.source.cacheAgeSeconds).toBe(age);
		expect(feed.receiptDelaySeconds).toEqual({ conversion: 4, image: 2, video: 0 });
		const stamp = Date.parse(feed.observedAt);
		expect(toapisEffectiveObservations(feed).map((time) => (stamp - time) / 1000)).toEqual(
			[4, 2, 2, 2, 2, 0, 0].map((delay) => delay + (age ?? 0)),
		);
	},
);
