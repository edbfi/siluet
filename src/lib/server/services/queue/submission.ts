import { createHmac, timingSafeEqual } from "node:crypto";
import { sql } from "drizzle-orm";
import { editDisclosure } from "../../../shared/image-studio/edit-disclosure";
import { createImageReview } from "../../../shared/image-studio/review";
import { estimateReviewPrice } from "../../../shared/image-studio/review-price";
import type { PricingFeeds } from "../../../shared/pricing/feeds";
import type { ProviderId } from "../../../shared/providers/connections";
import { imageJobPollingWindowMs } from "../../db/image-job-schema";
import type { Installation } from "../../db/installation";
import type { providerStore } from "../../db/provider-store";
import { loadStudioPricingFeeds } from "../pricing/local-feed";
import type { LiveRequest } from "./request";

const invalid = { error: "invalid" } as const;
const stale = { error: "stale" } as const;
const tokenFormat = /^([a-f0-9-]{36})\.([a-f0-9]{64})\.([a-f0-9]{64})$/;

export async function createSubmissionQueue(
	installation: Installation,
	credential: ReturnType<typeof providerStore>["credential"],
	dispatch: (
		id: string,
		provider: ProviderId,
		key: string,
		request: LiveRequest["request"],
	) => Promise<void>,
	loadFeeds: (now: number) => Promise<PricingFeeds> = loadStudioPricingFeeds,
	now = Date.now,
	discloseEdit = editDisclosure,
) {
	const stored = await installation.use((db) =>
		db.get<{ secret: string }>(sql`SELECT secret FROM image_review_key WHERE singleton=1`),
	);
	if (!stored || !/^[0-9a-f]{64}$/i.test(stored.secret))
		throw new Error("Review signing key unavailable.");
	const key = Buffer.from(stored.secret, "hex");
	function digest(...fields: unknown[]) {
		return createHmac("sha256", key).update(JSON.stringify(fields)).digest("hex");
	}
	function signature(id: string, terms: string, owner: string, live: LiveRequest) {
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
		const quote = estimateReviewPrice(feeds, pricing, { count: 1, retryLimit: 0 }, time);
		const requiresConsent = quote.status === "unknown" || provider === "toapis";
		const priceTerms = [revision, quote, requiresConsent, feeds[provider] ?? null];
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
	async function review(owner: string, live: LiveRequest) {
		const provider = live.input.provider;
		const [saved, feeds] = await Promise.all([credential(provider), loadFeeds(now())]);
		if (!saved) return stale;
		const { terms, ...display } = reviewTerms(live, feeds, saved.revision, now());
		const id = crypto.randomUUID();
		return {
			token: [id, terms, signature(id, terms, owner, live)].join("."),
			...display,
			acceptUnknown: false,
		};
	}
	return {
		review,
		async submit(owner: string, live: LiveRequest) {
			const match = typeof live.token === "string" && tokenFormat.exec(live.token);
			if (!match) return invalid;
			const [, id, terms, signed] = match;
			if (!timingSafeEqual(Buffer.from(signed), Buffer.from(signature(id, terms, owner, live))))
				return invalid;
			const binding = digest("accepted-v1", signed, live.acceptUnknown);
			const existing = sql`SELECT binding FROM image_job WHERE id=${id}`;
			const replay = (row: { binding: string }) =>
				row.binding === binding ? { jobId: id } : invalid;
			const prior = await installation.use((db) => db.get<{ binding: string }>(existing));
			if (prior) return replay(prior);

			const provider = live.input.provider;
			const [saved, feeds] = await Promise.all([credential(provider), loadFeeds(now())]);
			const claimed = await installation.use((db) =>
				db.transaction(
					async (tx) => {
						const concurrent = await tx.get<{ binding: string }>(existing);
						if (concurrent) return replay(concurrent);
						if (!saved) return stale;
						const current = await tx.get<{
							revision: number;
						}>(sql`SELECT revision FROM provider_credential
					WHERE provider=${provider} AND ciphertext IS NOT NULL AND seedream=1`);
						if (current?.revision !== saved.revision) return stale;
						const time = now();
						const reviewed = reviewTerms(live, feeds, saved.revision, time);
						if (reviewed.terms !== terms) return stale;
						if (reviewed.requiresConsent && !live.acceptUnknown) return invalid;
						await tx.run(sql`INSERT INTO image_job(id,binding,provider,revision,quote,accepted_unknown,state,created_at,model,poll_deadline)
					VALUES(${id},${binding},${provider},${saved.revision},${JSON.stringify(reviewed.quote)},${Number(live.acceptUnknown)},'submitting',${time},${live.input.model},${time + imageJobPollingWindowMs})`);
						return { key: saved.key };
					},
					{ behavior: "immediate" },
				),
			);
			if (!("key" in claimed)) {
				if (!("error" in claimed) || claimed.error !== "stale") return claimed;
				const fresh = await review(owner, live);
				return "token" in fresh ? { error: "stale" as const, review: fresh } : stale;
			}
			// Only the transaction that inserted the job can dispatch.
			await dispatch(id, provider, claimed.key, live.request);
			return { jobId: id };
		},
	};
}
