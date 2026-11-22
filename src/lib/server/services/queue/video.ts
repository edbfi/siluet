import { timingSafeEqual } from "node:crypto";
import { sql } from "drizzle-orm";
import { estimateReviewPrice } from "../../../shared/image-studio/review-price";
import { queueEvidenceProblem, seedanceOperation } from "../../../shared/media-catalog/registry";
import {
	previewVideo,
	type VideoRequest,
	videoDisclosures,
} from "../../../shared/video-studio/seedance";
import { imageJobPollingWindowMs } from "../../db/image-job-schema";
import type { Installation } from "../../db/installation";
import { nextProviderStart } from "../../db/provider-gate";
import { loadStudioPricingFeeds } from "../pricing/studio-feeds";
import {
	accessMessage,
	type createVideoAccess,
	type VideoAccess,
	videoInventoryQuery,
} from "../providers/video-access";
import { qualifiedVerifier } from "../video-media/native";
import { reviewSigner, tokenFormat } from "./review-signature";

export async function createVideoQueue(
	installation: Installation,
	access: ReturnType<typeof createVideoAccess>,
	dispatch: (
		id: string,
		key: string,
		body: VideoRequest["body"],
		business: string,
	) => Promise<void>,
	verifier = qualifiedVerifier,
	feeds = loadStudioPricingFeeds,
	now = Date.now,
) {
	const sign = await reviewSigner(installation);
	const invalid = { error: "invalid" } as const;
	const stale = { error: "stale" } as const;
	function signature(id: string, terms: string, owner: string, input: VideoRequest) {
		return sign("video-review-v1", id, terms, owner, seedanceOperation.key, input.body, 1, 0);
	}
	async function environment() {
		const [key, build] = await Promise.all([access.current(), verifier()]);
		return { ...key, build };
	}
	function terms(
		input: VideoRequest,
		context: Awaited<ReturnType<typeof environment>>,
		current: VideoAccess | null | undefined,
		pricing: Awaited<ReturnType<typeof feeds>>,
		time: number,
	) {
		const quote = estimateReviewPrice(
			pricing,
			{
				provider: "toapis",
				operation: "generate",
				model: input.body.model,
				options: input.options,
				sourceCount: 0,
			},
			{ count: 1, retryLimit: 0 },
			time,
		);
		const state = current?.state ?? "disconnected";
		const blockers = [
			queueEvidenceProblem(seedanceOperation.evidence),
			state === "eligible" ? null : accessMessage[state],
			context.build ? null : "A qualified local video verifier is unavailable.",
		].filter((s): s is string => !!s);
		const digest = sign(
			"video-terms-v1",
			current?.revision,
			state,
			current?.checked_at,
			context.build?.identity,
			quote,
			videoDisclosures,
			blockers,
		);
		return { quote, blockers, digest };
	}
	return {
		async review(owner: string, input: VideoRequest) {
			const context = await environment();
			const { quote, blockers, digest } = terms(
				input,
				context,
				context.record,
				await feeds(now()),
				now(),
			);
			const id = crypto.randomUUID();
			return {
				token: [id, digest, signature(id, digest, owner, input)].join("."),
				quote,
				blockers,
				disclosures: videoDisclosures,
				preview: previewVideo(input.body),
			};
		},
		async submit(owner: string, input: VideoRequest) {
			const match = typeof input.token === "string" && tokenFormat.exec(input.token);
			if (!match || !input.acceptTerms) return invalid;
			const [, id, reviewed, signed] = match;
			if (!timingSafeEqual(Buffer.from(signed), Buffer.from(signature(id, reviewed, owner, input))))
				return invalid;
			const binding = sign("video-accepted-v1", signed, input.acceptTerms);
			const existing = sql`SELECT binding FROM image_job WHERE id=${id}`;
			const replay = (row: { binding: string }) =>
				row.binding === binding ? { jobId: id } : invalid;
			const prior = await installation.use((db) => db.get<{ binding: string }>(existing));
			if (prior) return replay(prior);
			const context = await environment();
			const claim = await installation.use((db) =>
				db.transaction(
					async (tx) => {
						const competing = await tx.get<{ binding: string }>(existing);
						if (competing) return replay(competing);
						const current = await tx.get<VideoAccess>(videoInventoryQuery);
						const pricing = await feeds(now());
						const time = now();
						const termsNow = terms(input, context, current, pricing, time);
						if (
							!context.saved ||
							current?.revision !== context.saved.revision ||
							termsNow.digest !== reviewed ||
							termsNow.blockers.length
						)
							return stale;
						const until = await nextProviderStart(tx, "toapis", "submit", time);
						if (until > time) return { error: "cooldown" as const, until };
						const business = `siluet-${crypto.randomUUID()}`;
						await tx.run(sql`INSERT INTO image_job(id,binding,provider,revision,model,operation,quote,accepted_unknown,state,created_at,poll_deadline,business_id,video_terms)
					VALUES(${id},${binding},'toapis',${current.revision},${input.body.model},${seedanceOperation.key.operation},${JSON.stringify(termsNow.quote)},1,'submitting',${time},${time + imageJobPollingWindowMs},${business},${JSON.stringify(videoDisclosures)})`);
						return { business, key: context.saved.key };
					},
					{ behavior: "immediate" },
				),
			);
			if (!("business" in claim) || claim.business === undefined) return claim;
			await dispatch(id, claim.key, input.body, claim.business);
			return { jobId: id };
		},
	};
}
