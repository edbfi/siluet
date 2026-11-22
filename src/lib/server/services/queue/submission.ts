import { timingSafeEqual } from "node:crypto";
import { sql } from "drizzle-orm";
import { editDisclosure } from "../../../shared/image-studio/edit-disclosure";
import { zImageDisclosure } from "../../../shared/image-studio/z-image";
import { queueEvidenceProblem } from "../../../shared/media-catalog/registry";
import type { PricingFeeds } from "../../../shared/pricing/feeds";
import type { ProviderId } from "../../../shared/providers/connections";
import { credentialPermitsImage, imageCredentialAccess } from "../../db/image-credential-access";
import { imageJobPollingWindowMs } from "../../db/image-job-schema";
import type { Installation } from "../../db/installation";
import { nextProviderStart } from "../../db/provider-gate";
import type { providerStore } from "../../db/provider-store";
import { loadStudioPricingFeeds } from "../pricing/local-feed";
import type { BatchAuthorization } from "./batch-dispatch";
import type { LiveRequest } from "./request";
import { batchDisclosureVersion, reviewBinding } from "./review-binding";
import { reviewSigner, tokenFormat } from "./review-signature";

const invalid = { error: "invalid" } as const;
const stale = { error: "stale" } as const;

type SingleDispatch = (
	id: string,
	provider: ProviderId,
	key: string,
	request: LiveRequest["request"],
) => Promise<void>;

export async function createSubmissionQueue(
	installation: Installation,
	credential: ReturnType<typeof providerStore>["credential"],
	dispatcher:
		| SingleDispatch
		| { dispatch: SingleDispatch; dispatchBatch: (auth: BatchAuthorization) => Promise<void> },
	loadFeeds: (now: number) => Promise<PricingFeeds> = loadStudioPricingFeeds,
	now = Date.now,
	discloseEdit = editDisclosure,
	discloseZImage = zImageDisclosure,
) {
	const { dispatch, dispatchBatch } =
		typeof dispatcher === "function"
			? { dispatch: dispatcher, dispatchBatch: undefined }
			: dispatcher;
	const { signature, reviewTerms, digest } = reviewBinding(
		await reviewSigner(installation),
		discloseEdit,
		discloseZImage,
	);
	async function review(owner: string, live: LiveRequest) {
		if (live.replayOnly || queueEvidenceProblem(live.entry.evidence)) return invalid;
		const provider = live.input.provider;
		const [saved, feeds] = await Promise.all([
			credential(provider, undefined, imageCredentialAccess(provider, live.input.model)),
			loadFeeds(now()),
		]);
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
		async submit(owner: string, input: LiveRequest) {
			const live = structuredClone(input);
			const match = typeof live.token === "string" && tokenFormat.exec(live.token);
			if (!match) return invalid;
			const [, id, terms, signed] = match;
			if (!timingSafeEqual(Buffer.from(signed), Buffer.from(signature(id, terms, owner, live))))
				return invalid;
			const binding = digest("accepted-v1", signed, live.acceptUnknown);
			const batch = live.count !== 1 || live.retryLimit !== 0;
			const existing = batch
				? sql`SELECT binding FROM image_batch WHERE id=${id}`
				: sql`SELECT binding FROM image_job WHERE id=${id}`;
			const replay = (row: { binding: string }) =>
				row.binding === binding ? { jobId: id } : invalid;
			// An accepted Review keeps its original binding when disclosures or credentials change.
			const prior = await installation.use((db) => db.get<{ binding: string }>(existing));
			if (prior) return replay(prior);
			if (live.replayOnly || queueEvidenceProblem(live.entry.evidence)) return invalid;

			const provider = live.input.provider;
			const [saved, feeds] = await Promise.all([
				credential(provider, undefined, imageCredentialAccess(provider, live.input.model)),
				loadFeeds(now()),
			]);
			const claimed = await installation.use((db) =>
				db.transaction(
					async (tx) => {
						const concurrent = await tx.get<{ binding: string }>(existing);
						if (concurrent) return replay(concurrent);
						if (!saved) return stale;
						const current = await tx.get<{
							revision: number;
						}>(sql`SELECT c.revision FROM provider_credential c
					WHERE c.provider=${provider} AND c.ciphertext IS NOT NULL AND ${credentialPermitsImage(live.input.model)}`);
						if (current?.revision !== saved.revision) return stale;
						const time = now();
						const reviewed = reviewTerms(live, feeds, saved.revision, time);
						if (reviewed.terms !== terms) return stale;
						if (reviewed.requiresConsent && !live.acceptUnknown) return invalid;
						if (batch) {
							if (!dispatchBatch || live.entry.modelId !== "seedream-5.5") return invalid;
							await tx.run(sql`INSERT INTO image_batch(id,binding,provider,revision,quote,accepted_unknown,model,operation,
								terms_digest,disclosure_version,request_count,retry_limit,created_at,deadline)
								VALUES(${id},${binding},${provider},${saved.revision},${JSON.stringify(reviewed.quote)},${Number(live.acceptUnknown)},
								${live.input.model},${live.input.operation},${terms},${batchDisclosureVersion},${live.count},${live.retryLimit},${time},${time + 120_000})`);
						} else {
							const until = await nextProviderStart(tx, provider, "submit", time);
							if (until > time) return { error: "cooldown" as const, until };
							await tx.run(sql`INSERT INTO image_job(id,binding,provider,revision,quote,accepted_unknown,state,created_at,model,operation,poll_deadline)
					VALUES(${id},${binding},${provider},${saved.revision},${JSON.stringify(reviewed.quote)},${Number(live.acceptUnknown)},'submitting',${time},${live.input.model},${live.entry.key.operation},${time + imageJobPollingWindowMs})`);
						}
						return { key: saved.key, revision: saved.revision, deadline: time + 120_000 };
					},
					{ behavior: "immediate" },
				),
			);
			if (!("key" in claimed) || claimed.key === undefined) {
				if (!("error" in claimed) || claimed.error !== "stale") return claimed;
				const fresh = await review(owner, live);
				return "token" in fresh ? { error: "stale" as const, review: fresh } : stale;
			}
			// Only the transaction that inserted the job can dispatch.
			if (batch && dispatchBatch) {
				void dispatchBatch({
					id,
					deadline: claimed.deadline,
					count: live.count,
					retryLimit: live.retryLimit,
					key: claimed.key,
					provider,
					request: live.request,
					checkTerms: async () => {
						const feeds = await loadFeeds(now());
						return () => reviewTerms(live, feeds, claimed.revision, now()).terms === terms;
					},
				}).catch(() => console.error("Image batch dispatch interrupted."));
			} else await dispatch(id, provider, claimed.key, live.request);
			return { jobId: id };
		},
	};
}
