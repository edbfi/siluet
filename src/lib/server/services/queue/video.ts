import { timingSafeEqual } from "node:crypto";
import { sql } from "drizzle-orm";
import { estimateReviewPrice } from "../../../shared/image-studio/review-price";
import { queueEvidenceProblem } from "../../../shared/media-catalog/registry";
import { frameReviewLabels } from "../../../shared/video-studio/keyframes";
import type { PoyoVideoBody } from "../../../shared/video-studio/poyo-video";
import { previewVideo, type VideoRequest } from "../../../shared/video-studio/request";
import { saveLimitProblem } from "../../../shared/video-studio/save-profile";
import type { SeedanceBody } from "../../../shared/video-studio/seedance";
import { imageJobPollingWindowMs } from "../../db/image-job-schema";
import type { Installation } from "../../db/installation";
import { nextProviderStart } from "../../db/provider-gate";
import { loadStudioPricingFeeds } from "../pricing/studio-feeds";
import {
	accessMessage,
	accessQuery,
	type createVideoAccess,
	poyoAccessMessage,
	type VideoAccess,
} from "../providers/video-access";
import { reviewSigner, tokenFormat } from "./review-signature";

/** The provider request of one claimed video job. Only ToAPIs has a correlation ID. */
export type VideoTarget =
	| { provider: "toapis"; body: SeedanceBody; business: string }
	| { provider: "poyo"; body: PoyoVideoBody };

function target(input: VideoRequest, business: string | null): VideoTarget | null {
	if ("input" in input.body)
		return business === null ? { provider: "poyo", body: input.body } : null;
	return business === null ? null : { provider: "toapis", body: input.body, business };
}

export async function createVideoQueue(
	installation: Installation,
	access: ReturnType<typeof createVideoAccess>,
	dispatch: (id: string, key: string, target: VideoTarget) => Promise<void>,
	feeds = loadStudioPricingFeeds,
	now = Date.now,
) {
	const sign = await reviewSigner(installation);
	const invalid = { error: "invalid" } as const;
	const stale = { error: "stale" } as const;
	// Each operation signs its own exact key; text-to-video keeps its original signature bytes.
	function signature(id: string, terms: string, owner: string, input: VideoRequest) {
		return sign("video-review-v1", id, terms, owner, input.operation.key, input.body, 1, 0);
	}
	function terms(
		input: VideoRequest,
		current: VideoAccess | null | undefined,
		pricing: Awaited<ReturnType<typeof feeds>>,
		time: number,
	) {
		const { provider } = input.operation.key;
		const quote = estimateReviewPrice(
			pricing,
			{
				provider,
				operation: input.operation.mode,
				model:
					"descriptor" in input.operation ? input.operation.descriptor.rateKey : input.body.model,
				options: input.options,
				sourceCount: input.frames.length,
				sourceKinds: input.frames.map(() => "image" as const),
			},
			{ count: 1, retryLimit: 0 },
			time,
		);
		const state = current?.state ?? "disconnected";
		const blockers = [
			queueEvidenceProblem(input.operation.evidence),
			saveLimitProblem(input.operation),
			state === "eligible" ? null : provider === "poyo" ? poyoAccessMessage : accessMessage[state],
		].filter((s): s is string => !!s);
		const digest = sign(
			"video-terms-v1",
			current?.revision,
			state,
			current?.checked_at,
			quote,
			input.disclosures,
			blockers,
			input.operation.save,
		);
		return { quote, blockers, digest };
	}
	return {
		async review(owner: string, input: VideoRequest) {
			const { record } = await access.current(input.operation.key.provider);
			const { quote, blockers, digest } = terms(input, record, await feeds(now()), now());
			const id = crypto.randomUUID();
			return {
				token: [id, digest, signature(id, digest, owner, input)].join("."),
				quote,
				blockers,
				disclosures: input.disclosures,
				frames: frameReviewLabels(input.frames),
				preview: previewVideo(input),
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
			const context = await access.current(input.operation.key.provider);
			const { provider, operation } = input.operation.key;
			const claim = await installation.use((db) =>
				db.transaction(
					async (tx) => {
						const competing = await tx.get<{ binding: string }>(existing);
						if (competing) return replay(competing);
						const current = await tx.get<VideoAccess>(accessQuery(provider));
						const pricing = await feeds(now());
						const time = now();
						const termsNow = terms(input, current, pricing, time);
						if (
							!context.saved ||
							current?.revision !== context.saved.revision ||
							termsNow.digest !== reviewed ||
							termsNow.blockers.length
						)
							return stale;
						const until = await nextProviderStart(tx, provider, "submit", time);
						if (until > time) return { error: "cooldown" as const, until };
						const business = provider === "toapis" ? `siluet-${crypto.randomUUID()}` : null;
						const send = target(input, business);
						if (!send) return invalid;
						// No blocker means the operation has a valid Save limit; the job keeps it.
						const save = input.operation.save?.seconds ?? null;
						await tx.run(sql`INSERT INTO image_job(id,binding,provider,revision,model,operation,quote,accepted_unknown,state,created_at,poll_deadline,business_id,video_terms,save_seconds)
					VALUES(${id},${binding},${provider},${current.revision},${input.body.model},${operation},${JSON.stringify(termsNow.quote)},${Number(termsNow.quote.status === "unknown")},'submitting',${time},${time + imageJobPollingWindowMs},${business},${JSON.stringify(input.disclosures)},${save})`);
						return { send, key: context.saved.key };
					},
					{ behavior: "immediate" },
				),
			);
			if (!("send" in claim) || !claim.send || typeof claim.key !== "string") return claim;
			await dispatch(id, claim.key, claim.send);
			return { jobId: id };
		},
	};
}
