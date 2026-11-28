import { timingSafeEqual } from "node:crypto";
import { sql } from "drizzle-orm";
import { estimateReviewPrice } from "../../../shared/image-studio/review-price";
import { filteringFields, queueEvidenceProblem } from "../../../shared/media-catalog/filtering";
import {
	accessQueues,
	accessText,
	type ModelAccess,
	skippedText,
} from "../../../shared/providers/inventory";
import { frameReviewLabels, roleMedia } from "../../../shared/video-studio/keyframes";
import type { PoyoVideoBody } from "../../../shared/video-studio/poyo-video";
import { previewVideo, type VideoRequest } from "../../../shared/video-studio/request";
import { saveLimitProblem } from "../../../shared/video-studio/save-profile";
import type { SeedanceBody } from "../../../shared/video-studio/seedance";
import { imageJobPollingWindowMs } from "../../db/image-job-schema";
import type { Installation, InstallationTransaction } from "../../db/installation";
import { inventoryAccess } from "../../db/inventory-store";
import { nextProviderStart } from "../../db/provider-gate";
import { defaultModelListOrigin } from "../../providers/toapis/model-list";
import { loadStudioPricingFeeds } from "../pricing/studio-feeds";
import type { Inventory } from "../providers/inventory";
import {
	type createVideoAccess,
	type PoyoVideoAccess,
	poyoAccessMessage,
	poyoAccessQuery,
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

export const closedAbsentSendsField =
	"Queue is unavailable because this request still sends the filtering flag, which the provider's schema does not accept.";

/**
 * A closed-absent row must omit the filtering field, but every shipped video body still sends
 * it until G7 builds the body from the row. Until then such a row stays blocked.
 */
function closedAbsentProblem(input: VideoRequest) {
	if (input.operation.evidence.d4 !== "closed-absent") return null;
	const sent: object = "input" in input.body ? input.body.input : input.body;
	return Object.hasOwn(sent, filteringFields[input.operation.key.provider])
		? closedAbsentSendsField
		: null;
}

/** What a video Review shows and binds about the key's access to its exact operation. */
type Evidence =
	| { provider: "poyo"; record: PoyoVideoAccess | null | undefined }
	| { provider: "toapis"; access: ModelAccess; skipped: boolean };

/**
 * The ToAPIs access line a Review shows for its exact model, with Check again. Poyo.ai keeps its
 * balance-verified note and has none.
 */
function accessLine(input: VideoRequest, evidence: Evidence) {
	if (evidence.provider !== "toapis") return null;
	return {
		state: evidence.access.state,
		queues: accessQueues(evidence.access),
		text: evidence.skipped
			? skippedText
			: accessText(evidence.access, input.operation.key.model, "video"),
	};
}

export async function createVideoQueue(
	installation: Installation,
	access: ReturnType<typeof createVideoAccess>,
	dispatch: (id: string, key: string, target: VideoTarget) => Promise<void>,
	feeds = loadStudioPricingFeeds,
	now = Date.now,
	/** Runs a Review's automatic check on a stale snapshot. Without it, Review only reads. */
	inventory?: Pick<Inventory, "review" | "origin">,
) {
	const sign = await reviewSigner(installation);
	const invalid = { error: "invalid" } as const;
	const origin = inventory?.origin ?? defaultModelListOrigin;
	// Each operation signs its own exact key; text-to-video keeps its original signature bytes.
	function signature(id: string, terms: string, owner: string, input: VideoRequest) {
		return sign("video-review-v1", id, terms, owner, input.operation.key, input.body, 1, 0);
	}
	function terms(
		input: VideoRequest,
		evidence: Evidence,
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
				sourceKinds: input.frames.map(({ role }) => roleMedia(role)),
			},
			{ count: 1, retryLimit: 0 },
			time,
		);
		const line = accessLine(input, evidence);
		const record = evidence.provider === "poyo" ? evidence.record : null;
		const blockers = [
			queueEvidenceProblem(
				input.operation.evidence,
				input.operation.key.provider,
				input.disclosures,
			),
			closedAbsentProblem(input),
			saveLimitProblem(input.operation),
			line ? (line.queues ? null : line.text) : record ? null : poyoAccessMessage,
		].filter((s): s is string => !!s);
		// Poyo.ai keeps its digest inputs; ToAPIs binds its revision, state, check time and basis.
		const digest =
			evidence.provider === "poyo"
				? sign(
						"video-terms-v1",
						record?.revision,
						record?.state ?? "disconnected",
						record?.checked_at,
						quote,
						input.disclosures,
						blockers,
						input.operation.save,
					)
				: sign(
						"video-terms-v1",
						evidence.access.revision,
						evidence.access.state,
						evidence.access.checkedAt,
						quote,
						input.disclosures,
						blockers,
						input.operation.save,
						evidence.access.basis,
					);
		return { quote, blockers, digest, line };
	}
	/** The access evidence read in a claim's transaction, against the key the claim decrypted. */
	async function claimEvidence(
		tx: Pick<InstallationTransaction, "get">,
		input: VideoRequest,
		readable: number | null,
		time: number,
	): Promise<Evidence> {
		if (input.operation.key.provider === "poyo")
			return { provider: "poyo", record: await tx.get<PoyoVideoAccess>(poyoAccessQuery) };
		return {
			provider: "toapis",
			access: await inventoryAccess(
				tx,
				{ origin, scope: "video", key: input.operation.key, readable },
				time,
			),
			skipped: false,
		};
	}
	/** A Review. Only an opened Review runs the automatic check; a stale claim's answer only reads. */
	async function review(owner: string, input: VideoRequest, automatic = true) {
		const { provider } = input.operation.key;
		const { record, saved } = await access.current(provider);
		let evidence: Evidence;
		if (provider === "poyo") evidence = { provider, record };
		else if (inventory && automatic && saved) {
			const reviewed = await inventory.review(input.operation.key, "video");
			evidence = { provider, ...reviewed };
		} else {
			const time = now();
			evidence = await installation.use((db) =>
				claimEvidence(db, input, saved?.revision ?? null, time),
			);
		}
		const { quote, blockers, digest, line } = terms(input, evidence, await feeds(now()), now());
		const id = crypto.randomUUID();
		return {
			token: [id, digest, signature(id, digest, owner, input)].join("."),
			quote,
			blockers,
			access: line && { state: line.state, text: line.text },
			disclosures: input.disclosures,
			frames: frameReviewLabels(input.frames),
			preview: previewVideo(input),
		};
	}
	return {
		review: (owner: string, input: VideoRequest) => review(owner, input),
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
			const stale = { error: "stale" } as const;
			const claim = await installation.use((db) =>
				db.transaction(
					async (tx) => {
						const competing = await tx.get<{ binding: string }>(existing);
						if (competing) return replay(competing);
						const pricing = await feeds(now());
						const time = now();
						// Freshness and the credential revision are re-read in this transaction.
						const evidence = await claimEvidence(tx, input, context.saved?.revision ?? null, time);
						const revision =
							evidence.provider === "poyo" ? evidence.record?.revision : evidence.access.revision;
						const termsNow = terms(input, evidence, pricing, time);
						if (
							!context.saved ||
							revision !== context.saved.revision ||
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
					VALUES(${id},${binding},${provider},${context.saved.revision},${input.body.model},${operation},${JSON.stringify(termsNow.quote)},${Number(termsNow.quote.status === "unknown")},'submitting',${time},${time + imageJobPollingWindowMs},${business},${JSON.stringify(input.disclosures)},${save})`);
						return { send, key: context.saved.key };
					},
					{ behavior: "immediate" },
				),
			);
			// A stale claim answers with a fresh Review, which sends nothing to the provider.
			if ("error" in claim && claim.error === "stale")
				return { error: "stale" as const, review: await review(owner, input, false) };
			if (!("send" in claim) || !claim.send || typeof claim.key !== "string") return claim;
			await dispatch(id, claim.key, claim.send);
			return { jobId: id };
		},
	};
}
