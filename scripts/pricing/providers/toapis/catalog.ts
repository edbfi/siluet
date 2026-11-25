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

function parseTable(
	html: string,
	url: string,
	model: string,
	expectedColumns: string[],
	rowLabels: string[],
) {
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
		rows.length !== rowLabels.length ||
		rows.some(
			(row, index) =>
				row.length !== expectedColumns.length || normalizeText(row[0]) !== rowLabels[index],
		)
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

// Reviewed on 2026-11-24: the only statement about reference images in billing terms.
const referenceNote =
	/^Ordinary generation returns one image; layer decomposition returns a base image and PNG layers\. Reference images are billed at \$([\d.]+) per image\. Billing settles when the task completes\.$/;

/** The one paragraph that ties reference images to billing, read as its amount in USD. */
function readReferenceNote(html: string, title: string): string {
	const paragraphs: string[] = [];
	new HTMLRewriter()
		.on("main p", {
			element() {
				paragraphs.push("");
			},
			text(chunk) {
				paragraphs[paragraphs.length - 1] += chunk.text;
			},
		})
		.transform(html);
	const notes = paragraphs
		.map(normalizeText)
		.filter((text) => /reference/i.test(text) && /\b(?:bill|charge|free)/i.test(text));
	const usd = notes.length === 1 ? referenceNote.exec(notes[0])?.[1] : undefined;
	if (!isCreditRate(usd)) {
		throw new Error(`The ToAPIs ${title} reference-image billing note has changed or is missing.`);
	}
	return usd;
}

// One Next.js flight chunk: self.__next_f.push([1,"<JSON string literal>"]).
const flightChunk = /^self\.__next_f\.push\(\[\d+(?:,("(?:[^"\\]|\\.)*"))?\]\)$/;
// One flight row: <hex id>:<JSON>.
const flightRow = /^[0-9a-f]+:(.*)$/s;
const inputImageData = /"inputImage":\{"usd":(\d+(?:\.\d+)?),"freeCount":(\d+)\}/g;

/** Every record in the decoded rows that carries its own inputImage entry. */
function inputImageOwners(value: unknown): Record<string, unknown>[] {
	if (Array.isArray(value)) return value.flatMap(inputImageOwners);
	if (value === null || typeof value !== "object") return [];
	const record = value as Record<string, unknown>;
	const nested = Object.values(record).flatMap(inputImageOwners);
	return Object.hasOwn(record, "inputImage") ? [record, ...nested] : nested;
}

/** The page's own pricing data for the model's reference images, decoded from its flight string. */
function readInputImageData(
	html: string,
	model: string,
	title: string,
): { usd: string; freeCount: string } {
	const scripts: string[] = [];
	new HTMLRewriter()
		.on("script", {
			element() {
				scripts.push("");
			},
			text(chunk) {
				scripts[scripts.length - 1] += chunk.text;
			},
		})
		.transform(html);
	const payloads = scripts.flatMap((script) => {
		const literal = flightChunk.exec(script.trim())?.[1];
		if (literal === undefined) return [];
		let payload: unknown;
		try {
			payload = JSON.parse(literal);
		} catch {
			throw new Error(`Unreadable ToAPIs ${title} page data.`);
		}
		return typeof payload === "string" ? [payload] : [];
	});
	const matches = payloads.flatMap((payload) => [...payload.matchAll(inputImageData)]);
	// Any other copy of the entry, escaped or not, makes the source ambiguous.
	if (matches.length !== 1 || html.split("inputImage").length !== 2) {
		throw new Error(`The ToAPIs ${title} reference-image page data has changed or is missing.`);
	}
	// The amount counts only when the record holding it names this model. A row split across
	// chunks does not decode on its own and fails closed.
	const owners = payloads
		.flatMap((payload) => payload.split("\n"))
		.filter((row) => row.includes("inputImage"))
		.flatMap((row) => {
			try {
				return inputImageOwners(JSON.parse(flightRow.exec(row)?.[1] ?? ""));
			} catch {
				throw new Error(`Unreadable ToAPIs ${title} page data.`);
			}
		});
	if (owners.length !== 1 || owners[0].modelId !== model) {
		throw new Error(`The ToAPIs ${title} reference-image page data belongs to another model.`);
	}
	const [, usd, freeCount] = matches[0];
	return { usd, freeCount };
}

export function readImageRates(page: PricingPage) {
	const model = "doubao-seedream-5-5";
	const title = "Seedream 5.5";
	const [small, large, input] = parseTable(
		page.html,
		imageSourceUrl,
		title,
		["Specification", "ToAPIs price", "Savings", "ByteDance official list"],
		["1K / 1.5K", "2K", "Image input"],
	);
	const source = modelSource(imageSourceUrl, page.cacheAgeSeconds);
	const tiers = (["1K", "1.5K", "2K"] as const).map(
		(size) =>
			({
				model,
				operations: ["generate", "edit"],
				unit: "image",
				conditions: { size, outputCount: 1, layerDecomposition: false },
				...readPrice((size === "2K" ? large : small)[1], "image", title),
				source,
			}) as const,
	);

	// Each reference image is charged on top of the output tier. The table, the note below it
	// and the page data must all state the same flat amount with no free allowance.
	if (input[2] !== "-" || !/^ByteDance official list\s*-\s*image$/.test(input[3])) {
		throw new Error(`Unexpected ToAPIs ${title} image input row.`);
	}
	const reference = readPrice(input[1], "image", title);
	const noteUsd = readReferenceNote(page.html, title);
	const data = readInputImageData(page.html, model, title);
	const amount = creditUnits(reference.usd);
	if (
		creditUnits(noteUsd) !== amount ||
		!isCreditRate(data.usd) ||
		creditUnits(data.usd) !== amount ||
		data.freeCount !== "0"
	) {
		throw new Error(`The ToAPIs ${title} reference-image prices disagree.`);
	}
	return [
		...tiers,
		{
			model,
			operations: ["generate", "edit"],
			unit: "reference-image",
			conditions: { freeAllowance: 0 },
			...reference,
			source,
		} as const,
	];
}

export function readVideoRates(page: PricingPage) {
	const model = "seedance-2-5";
	const title = "Seedance 2.5";
	const rows = parseTable(
		page.html,
		videoSourceUrl,
		title,
		["Specification", "ToAPIs price", "Billing basis"],
		["No video input", "With video input"],
	);
	return [false, true].map((videoInput) => {
		const row = rows[Number(videoInput)];
		if (row[2] !== "1M total tokens") {
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
