import { decodeToapisPricingFeed } from "../../../../src/lib/shared/pricing/toapis-feed.ts";
import {
	conversionSourceUrl,
	imageSourceUrl,
	type PricingPage,
	readCreditConversion,
	readImageRates,
	readVideoRates,
	videoSourceUrl,
} from "./catalog.ts";

type SourceFetch = (url: string, init: RequestInit) => Promise<Response>;
const maxBodyBytes = 512 * 1024;

type ReceivedPage = PricingPage & { receivedMs: number };

async function readPage(
	fetchSource: SourceFetch,
	url: string,
	clock: () => Date,
): Promise<ReceivedPage> {
	const response = await fetchSource(url, {
		method: "GET",
		credentials: "omit",
		redirect: "error",
		headers: { Accept: "text/html", "Accept-Language": "en" },
		signal: AbortSignal.timeout(5_000),
	});
	const receivedMs = clock().getTime();
	const { body, headers, status } = response;
	if (status !== 200) {
		await body?.cancel().catch(() => {});
		throw new Error(`ToAPIs public page unavailable (HTTP ${status}).`);
	}
	if (headers.get("cf-mitigated") === "challenge") {
		await body?.cancel().catch(() => {});
		throw new Error("The ToAPIs public page returned a challenge.");
	}
	if (!body || !/^text\/html(?:\s*;|$)/i.test(headers.get("content-type") ?? "")) {
		await body?.cancel().catch(() => {});
		throw new Error("Expected HTML from the ToAPIs public page.");
	}
	const age = headers.get("age");
	const cacheAgeSeconds = age === null ? null : Number(age);
	if (age !== null && (!/^\d+$/.test(age) || !Number.isSafeInteger(cacheAgeSeconds))) {
		await body.cancel().catch(() => {});
		throw new Error("Invalid ToAPIs public page cache age.");
	}

	const reader = body.getReader();
	const decoder = new TextDecoder("utf-8", { fatal: true });
	let html = "";
	let bytesRead = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) return { html: html + decoder.decode(), cacheAgeSeconds, receivedMs };
			bytesRead += value.byteLength;
			if (bytesRead > maxBodyBytes) throw new Error("ToAPIs public page exceeds the size limit.");
			html += decoder.decode(value, { stream: true });
		}
	} catch (error) {
		await reader.cancel().catch(() => {});
		throw error;
	} finally {
		reader.releaseLock();
	}
}

function receiptDelay(page: ReceivedPage, observedMs: number) {
	const elapsed = Math.floor(observedMs / 1000) - Math.floor(page.receivedMs / 1000);
	if (elapsed < 0) throw new Error("Clock moved back while collecting ToAPIs prices.");
	return elapsed;
}

export async function collectToapisPricing(
	fetchSource: SourceFetch = fetch,
	now: Date | (() => Date) = () => new Date(),
) {
	const clock = typeof now === "function" ? now : () => now;
	const conversion = await readPage(fetchSource, conversionSourceUrl, clock);
	const creditsPerUsd = readCreditConversion(conversion);
	const image = await readPage(fetchSource, imageSourceUrl, clock);
	const imageRates = readImageRates(image);
	const video = await readPage(fetchSource, videoSourceUrl, clock);
	const videoRates = readVideoRates(video);
	const observed = clock();
	const feed = decodeToapisPricingFeed({
		version: 2,
		provider: "toapis",
		observedAt: observed.toISOString().replace(/\.\d{3}Z$/, "Z"),
		creditsPerUsd,
		conversionSourceUrl,
		conversionCacheAgeSeconds: conversion.cacheAgeSeconds,
		receiptDelaySeconds: {
			conversion: receiptDelay(conversion, observed.getTime()),
			image: receiptDelay(image, observed.getTime()),
			video: receiptDelay(video, observed.getTime()),
		},
		rates: [...imageRates, ...videoRates],
		gaps: [
			{ model: "doubao-seedream-5-5", reason: "unpriced-image-options" },
			{ model: "seedance-2-5", reason: "token-usage-unknown" },
		],
	});
	if (!feed) throw new Error("Invalid ToAPIs pricing snapshot.");
	return feed;
}

if (import.meta.main) {
	try {
		console.log(JSON.stringify(await collectToapisPricing(), null, "\t"));
	} catch (error) {
		console.error(error instanceof Error ? error.message : "ToAPIs pricing collection failed.");
		process.exitCode = 1;
	}
}
