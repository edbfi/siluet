import {
	creditUnits,
	formatCredits,
	isCreditRate,
} from "../../../../src/lib/shared/pricing/decimal.ts";

export const conversionSourceUrl = "https://toapis.com/pricing";
export const imageSourceUrl = "https://toapis.com/model-guide/doubao-seedream-5-5";
export const videoSourceUrl = "https://toapis.com/model-guide/seedance-2-5";
const creditsPerUsd = "200";

export type PricingPage = { html: string; cacheAgeSeconds: number | null };

function parsePage(html: string, url: string, label: string, rewriter: HTMLRewriter) {
	const canonical: (string | null)[] = [];
	rewriter
		.on('head link[rel="canonical"]', {
			element(element) {
				canonical.push(element.getAttribute("href"));
			},
		})
		.transform(html);
	if (canonical.length !== 1 || canonical[0] !== url) {
		throw new Error(`Unexpected ToAPIs canonical URL for ${label}.`);
	}
}

export function readCreditConversion({ html }: PricingPage): typeof creditsPerUsd {
	let display = "";
	const rewriter = new HTMLRewriter().on('main a[href="/dashboard/billing"]', {
		text(chunk) {
			display += chunk.text;
		},
	});
	parsePage(html, conversionSourceUrl, "credit conversion", rewriter);
	// The page advertises one credit ≈ $0.005. Review the conversion if this changes.
	if (!/^1 credit\s*≈\s*\$0\.005$/.test(display.trim())) {
		throw new Error("The ToAPIs public credit conversion has changed or is missing.");
	}
	return creditsPerUsd;
}

function normalizeText(text: string): string {
	return text.trim().replace(/\s+/g, " ");
}

function parseTable(html: string, url: string, model: string, expectedColumns: string[]) {
	const columns: string[] = [];
	const rows: string[][] = [];
	let title = "";
	let tableCount = 0;
	const rewriter = new HTMLRewriter()
		.on("main h1", {
			text(chunk) {
				title += chunk.text;
			},
		})
		.on("main table", {
			element() {
				tableCount++;
			},
		})
		.on("main table thead tr > th", {
			element() {
				columns.push("");
			},
			text(chunk) {
				columns[columns.length - 1] += chunk.text;
			},
		})
		.on("main table tbody tr", {
			element() {
				rows.push([]);
			},
		})
		.on("main table tbody tr > td", {
			element() {
				rows.at(-1)?.push("");
			},
			text(chunk) {
				const row = rows.at(-1);
				if (row) row[row.length - 1] += chunk.text;
			},
		});
	parsePage(html, url, model, rewriter);

	if (
		normalizeText(title) !== model ||
		tableCount !== 1 ||
		columns.length !== expectedColumns.length ||
		!columns.every((column, index) => normalizeText(column) === expectedColumns[index]) ||
		rows.length !== 2 ||
		rows.some((row) => row.length !== expectedColumns.length)
	) {
		throw new Error(`Unexpected ToAPIs ${model} pricing table.`);
	}
	return rows.map((row) => row.map(normalizeText));
}

function readPrice(cell: string, unit: "image" | "1M total tokens", model: string) {
	const match = /^ToAPIs\s*\$\s*([\d.]+)\s*(image|1M total tokens)$/.exec(cell);
	const usd = match?.[1];
	if (match?.[2] !== unit || !isCreditRate(usd)) {
		throw new Error(`Invalid ToAPIs ${model} advertised price or unit.`);
	}
	const units = creditUnits(usd);
	const approximateCredits = formatCredits(units * BigInt(creditsPerUsd));
	if (!isCreditRate(approximateCredits)) {
		throw new Error(`ToAPIs ${model} approximate credits exceed the decimal bounds.`);
	}
	return { usd: formatCredits(units), approximateCredits };
}

function modelSource(url: string, cacheAgeSeconds: number | null) {
	return {
		url,
		scope: "public-advertised",
		region: "global-site",
		tier: null,
		publishedAt: null,
		cacheAgeSeconds,
	} as const;
}

export function readImageRates(page: PricingPage) {
	const model = "doubao-seedream-5-5";
	const title = "Seedream 5.5";
	const rows = parseTable(page.html, imageSourceUrl, title, [
		"Specification",
		"ToAPIs price",
		"Savings",
		"ByteDance official list",
	]);
	return (["1K", "1.5K", "2K"] as const).map((size) => {
		const label = size === "2K" ? "2K" : "1K / 1.5K";
		const row = rows.find(([tier]) => tier === label);
		if (!row) throw new Error(`Missing ToAPIs ${title} advertised tier.`);
		return {
			model,
			operations: ["generate", "edit"],
			unit: "image",
			conditions: { size, outputCount: 1, layerDecomposition: false },
			...readPrice(row[1], "image", title),
			source: modelSource(imageSourceUrl, page.cacheAgeSeconds),
		} as const;
	});
}

export function readVideoRates(page: PricingPage) {
	const model = "seedance-2-5";
	const title = "Seedance 2.5";
	const rows = parseTable(page.html, videoSourceUrl, title, [
		"Specification",
		"ToAPIs price",
		"Billing basis",
	]);
	return [false, true].map((videoInput) => {
		const label = videoInput ? "With video input" : "No video input";
		const row = rows.find(([input]) => input === label);
		if (row?.[2] !== "1M total tokens") {
			throw new Error(`Missing ToAPIs ${title} advertised billing basis.`);
		}
		return {
			model,
			operations: ["generate", "edit"],
			unit: "million-total-tokens",
			conditions: { videoInput },
			...readPrice(row[1], "1M total tokens", title),
			source: modelSource(videoSourceUrl, page.cacheAgeSeconds),
		} as const;
	});
}
