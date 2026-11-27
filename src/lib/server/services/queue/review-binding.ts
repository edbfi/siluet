import { type DerivedWording, derivedQuote } from "../../../shared/image-studio/derived-review";
import type { editDisclosure } from "../../../shared/image-studio/edit-disclosure";
import { createImageReview } from "../../../shared/image-studio/review";
import { estimateReviewPrice } from "../../../shared/image-studio/review-price";
import { zImageDisclosure } from "../../../shared/image-studio/z-image";
import type { PricingFeeds } from "../../../shared/pricing/feeds";
import type { DerivedLiveRequest, DerivedRequest } from "./derived";
import type { LiveRequest } from "./request";
import type { reviewSigner } from "./review-signature";

export const batchDisclosureVersion = "batch-terms-v1";

export function reviewBinding(
	digest: Awaited<ReturnType<typeof reviewSigner>>,
	discloseEdit: typeof editDisclosure,
	discloseZImage = zImageDisclosure,
) {
	function signature(id: string, terms: string, owner: string, live: LiveRequest) {
		if (live.entry.modelId === "z-image")
			return digest("z-image-review-v1", id, terms, owner, live.entry.key, live.request, 1, 0);
		if (live.count !== 1 || live.retryLimit !== 0) {
			return digest(
				"batch-review-v1",
				id,
				terms,
				owner,
				live.input.operation,
				live.input.provider,
				live.request,
				live.count,
				live.retryLimit,
			);
		}
		if (live.input.operation === "edit") {
			const { method, url, body } = live.request;
			return digest(
				"edit-review-v1",
				id,
				terms,
				owner,
				live.input.provider,
				method,
				url,
				body,
				1,
				0,
			);
		}
		return digest("review-v1", id, terms, owner, live.input.provider, live.request.body, 1, 0);
	}
	function reviewTerms(live: LiveRequest, feeds: PricingFeeds, revision: number, time: number) {
		const provider = live.input.provider;
		const { pricing } = createImageReview(live.input, live.request);
		const quote = estimateReviewPrice(
			feeds,
			pricing,
			{ count: live.count, retryLimit: live.retryLimit },
			time,
		);
		const requiresConsent = quote.status === "unknown" || provider === "toapis";
		const priceTerms = [revision, quote, requiresConsent, feeds[provider] ?? null];
		if (live.entry.modelId === "z-image") {
			const disclosure = discloseZImage(live.input.operation);
			return {
				quote,
				requiresConsent,
				disclosure,
				terms: digest("z-image-terms-v1", ...priceTerms, disclosure),
			};
		}
		if (live.count !== 1 || live.retryLimit !== 0) {
			const disclosure = live.input.operation === "edit" ? discloseEdit(provider) : undefined;
			return {
				quote,
				requiresConsent,
				...(disclosure && { editDisclosure: disclosure }),
				terms: digest(
					batchDisclosureVersion,
					...priceTerms,
					live.count,
					live.retryLimit,
					disclosure,
				),
			};
		}
		if (live.input.operation === "edit") {
			const disclosure = discloseEdit(provider);
			return {
				quote,
				requiresConsent,
				editDisclosure: disclosure,
				terms: digest("edit-review-terms-v1", ...priceTerms, disclosure),
			};
		}
		return { quote, requiresConsent, terms: digest("review-terms-v1", ...priceTerms) };
	}
	/**
	 * derived-review-v1 signs what a submit carries, so a claimed Review replays without its row:
	 * the operation key and the draft exactly as submitted, at one request and zero retries.
	 */
	function derivedSignature(id: string, terms: string, owner: string, live: DerivedLiveRequest) {
		return digest("derived-review-v1", id, terms, owner, live.key, live.draft, 1, 0);
	}
	/**
	 * derived-terms-v1 binds the exact wire body, the row's contract digest and every bound
	 * statement. It is computed at Review and at a new claim, while the row exists. Every derived
	 * row's price is unknown until its rate basis is published (G4b), so Review asks for consent.
	 */
	function derivedTerms(
		live: DerivedLiveRequest & { row: NonNullable<DerivedLiveRequest["row"]> },
		request: DerivedRequest,
		wording: DerivedWording,
		feeds: PricingFeeds,
		revision: number,
	) {
		const quote = derivedQuote;
		const priceTerms = [revision, quote, true, feeds.poyo ?? null];
		return {
			quote,
			requiresConsent: true,
			wording,
			terms: digest("derived-terms-v1", ...priceTerms, request.body, live.row.contract, wording),
		};
	}
	return { digest, signature, reviewTerms, derivedSignature, derivedTerms };
}
