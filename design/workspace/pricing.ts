import { estimatePrice, type PriceInput } from "../../src/lib/shared/pricing/estimate";
import { decodePricingFeeds, isPricingProvider } from "../../src/lib/shared/pricing/feeds";
import { restoreToapisAttempt } from "./attempt-estimate";

declare const SILUET_WORKSPACE_PRICING: unknown;

const feeds = decodePricingFeeds(SILUET_WORKSPACE_PRICING);
const quote = (input: PriceInput) =>
	estimatePrice(
		isPricingProvider(input.provider) ? feeds[input.provider] : undefined,
		input,
		Date.now(),
	);
const unavailableReasons = {
	"unsupported-provider": "No verified rate for this provider.",
	"unsupported-model": "No verified rate for this model.",
	"unsupported-input": "The options or number of references fall outside the verified rate.",
	"missing-feed": "No local rate data available.",
	"expired-feed": "The published rates have expired.",
	"invalid-clock": "Check the device date.",
	"rate-unavailable": "The published rate could not be verified.",
	"token-usage-unknown": "The provider reports token usage after completion.",
};

function toapisImageAmount(credits: string, usd: string): string {
	return `≈${credits} ToAPIs credits · Advertised estimate ($${usd})`;
}

function toapisTokenRate(rate: { usd: string; approximateCredits: string }): string {
	return `Advertised rate: $${rate.usd} per million total tokens (≈${rate.approximateCredits} ToAPIs credits)`;
}

Object.assign(window, {
	SiluetPricing: {
		quote,
		restoreToapisAttempt,
		toapisImageAmount,
		toapisTokenRate,
		estimate(input: PriceInput) {
			const price = quote(input);
			let amount: string;
			if (price.status === "known") {
				const date = price.sourceDate.slice(0, 10);
				if (price.unit === "poyo_credit") {
					amount = `${price.batch} Poyo.ai credits estimated${input.count > 1 ? ` (${price.perRequest} per request)` : ""} · Rates dated ${date}`;
				} else {
					amount = `${toapisImageAmount(price.batch, price.usd.batch)}${input.count > 1 ? ` · ≈${price.perRequest} credits per request` : ""} · Rates observed ${date}`;
				}
			} else if (price.advertisedUnitRate) {
				amount = `Request total unknown · ${toapisTokenRate(price.advertisedUnitRate)} · Rates observed ${price.advertisedUnitRate.sourceDate.slice(0, 10)}`;
			} else {
				const reason =
					input.provider === "toapis" &&
					input.model === "doubao-seedream-5-5" &&
					price.reason === "unsupported-input"
						? "Advertised rates cover explicit 1K, 1.5K and 2K tiers with standard single-image options."
						: unavailableReasons[price.reason];
				amount = `Estimate unavailable · ${reason}`;
			}
			if (!input.retryLimit || price.maxAttempts === null) return amount;
			return `${amount} · Up to ${price.maxAttempts} attempts with retries. Total charge unknown.`;
		},
	},
});
