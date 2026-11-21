const source = (model: string) => ({
	url: `https://toapis.com/model-guide/${model}`,
	scope: "public-advertised",
	region: "global-site",
	tier: null,
	publishedAt: null,
	cacheAgeSeconds: null,
});

export const toapisRates = {
	version: 1,
	provider: "toapis",
	observedAt: "2026-11-20T12:00:00Z",
	creditsPerUsd: "200",
	conversionSourceUrl: "https://toapis.com/pricing",
	conversionCacheAgeSeconds: null,
	rates: [
		...["1K", "1.5K", "2K"].map((size) => ({
			model: "doubao-seedream-5-5",
			operations: ["generate", "edit"],
			unit: "image",
			conditions: { size, outputCount: 1, layerDecomposition: false },
			usd: size === "2K" ? "0.028" : "0.016",
			approximateCredits: size === "2K" ? "5.6" : "3.2",
			source: source("doubao-seedream-5-5"),
		})),
		...[false, true].map((videoInput) => ({
			model: "seedance-2-5",
			operations: ["generate", "edit"],
			unit: "million-total-tokens",
			conditions: { videoInput },
			usd: videoInput ? "6" : "10",
			approximateCredits: videoInput ? "1200" : "2000",
			source: source("seedance-2-5"),
		})),
	],
	gaps: [
		{ model: "doubao-seedream-5-5", reason: "unpriced-image-options" },
		{ model: "seedance-2-5", reason: "token-usage-unknown" },
	],
};
