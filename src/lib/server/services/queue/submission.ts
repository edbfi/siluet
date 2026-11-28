import { timingSafeEqual } from "node:crypto";
import { sql } from "drizzle-orm";
import { type DerivedWording, derivedWording } from "../../../shared/image-studio/derived-review";
import { editDisclosure } from "../../../shared/image-studio/edit-disclosure";
import { zImageDisclosure } from "../../../shared/image-studio/z-image";
import { queueingD4 } from "../../../shared/media-catalog/eligibility";
import { queueEvidenceProblem } from "../../../shared/media-catalog/filtering";
import type { QueueRow } from "../../../shared/media-catalog/queue-row";
import { seedreamRoutes } from "../../../shared/media-catalog/registry";
import type { PricingFeeds } from "../../../shared/pricing/feeds";
import type { ProviderId } from "../../../shared/providers/connections";
import { accessLine, accessQueues, type ModelAccess } from "../../../shared/providers/inventory";
import { credentialPermitsImage, imageCredentialAccess } from "../../db/image-credential-access";
import { imageJobPollingWindowMs } from "../../db/image-job-schema";
import type { Installation } from "../../db/installation";
import { inventoryAccess } from "../../db/inventory-store";
import { nextProviderStart } from "../../db/provider-gate";
import type { providerStore } from "../../db/provider-store";
import type { ReviewedImageRequest } from "../../providers/image-job";
import { loadStudioPricingFeeds } from "../pricing/studio-feeds";
import type { Inventory } from "../providers/inventory";
import type { BatchAuthorization } from "./batch-dispatch";
import { imageJobContract } from "./contract";
import { type DerivedLiveRequest, type DerivedRows, derivedRows, resolveDerived } from "./derived";
import type { LiveRequest } from "./request";
import { batchDisclosureVersion, reviewBinding } from "./review-binding";
import { reviewSigner, tokenFormat } from "./review-signature";

const invalid = { error: "invalid" } as const;
const stale = { error: "stale" } as const;

type SingleDispatch = (
	id: string,
	provider: ProviderId,
	key: string,
	request: ReviewedImageRequest,
) => Promise<void>;

/** Where derived rows resolve and what their Review binds; tests stand in for a re-pin here. */
export type DerivedQueueOptions = {
	readonly rows?: DerivedRows;
	readonly wording?: (row: QueueRow) => DerivedWording;
	/** Runs a ToAPIs Review's automatic check on a stale snapshot. Without it, Review only reads. */
	readonly inventory?: Pick<Inventory, "review">;
};

const inventoryOrigin = seedreamRoutes.toapis.origin;

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
	{ rows = derivedRows, wording = derivedWording, inventory }: DerivedQueueOptions = {},
) {
	const { dispatch, dispatchBatch } =
		typeof dispatcher === "function"
			? { dispatch: dispatcher, dispatchBatch: undefined }
			: dispatcher;
	const { signature, reviewTerms, digest, derivedSignature, derivedTerms } = reviewBinding(
		await reviewSigner(installation),
		discloseEdit,
		discloseZImage,
	);
	// Image Reviews bind no D4 wording yet, so only a declared row can queue here.
	const blocked = (live: LiveRequest) =>
		live.replayOnly || queueEvidenceProblem(live.entry.evidence, live.entry.key.provider) !== null;
	/**
	 * A ToAPIs Review's access evidence. Only an opened Review runs the automatic check on a stale
	 * snapshot; the fresh Review a stale claim answers with only reads.
	 */
	async function toapisAccess(live: LiveRequest, revision: number, automatic: boolean) {
		if (inventory && automatic) return inventory.review(live.entry.key, "image");
		const access = await installation.use((db) =>
			inventoryAccess(
				db,
				{ origin: inventoryOrigin, scope: "image", key: live.entry.key, readable: revision },
				now(),
			),
		);
		return { access, skipped: false };
	}
	async function reviewShipped(owner: string, live: LiveRequest, automatic = true) {
		if (blocked(live)) return invalid;
		const provider = live.input.provider;
		const [saved, feeds] = await Promise.all([
			credential(provider, undefined, imageCredentialAccess(provider, live.input.model)),
			loadFeeds(now()),
		]);
		if (!saved) return stale;
		const evidence =
			provider === "toapis" ? await toapisAccess(live, saved.revision, automatic) : null;
		const { terms, ...display } = reviewTerms(
			live,
			feeds,
			saved.revision,
			now(),
			evidence?.access ?? null,
		);
		const line =
			evidence && accessLine(evidence.access, live.input.model, "image", evidence.skipped);
		const id = crypto.randomUUID();
		return {
			token: [id, terms, signature(id, terms, owner, live)].join("."),
			...display,
			acceptUnknown: false,
			access: line && { state: line.state, text: line.text },
			blockers: line && !line.queues ? [line.text] : [],
		};
	}

	// Only declared and open-absent rows queue in this release, whatever wording another state
	// binds. A derived Review binds its row's D4 wording, so an open-absent row needs its disclosure.
	const derivedBlocked = (row: QueueRow, bound: DerivedWording) =>
		!queueingD4.includes(row.d4.d4) || queueEvidenceProblem(row.d4, "poyo", bound.d4) !== null;
	const derivedCredential = (live: DerivedLiveRequest) =>
		credential("poyo", undefined, imageCredentialAccess("poyo", live.key.model));

	async function reviewDerived(owner: string, live: DerivedLiveRequest) {
		const resolved = resolveDerived(live, rows);
		if (!resolved) return invalid;
		const bound = wording(resolved.row);
		if (derivedBlocked(resolved.row, bound)) return invalid;
		const [saved, feeds] = await Promise.all([derivedCredential(live), loadFeeds(now())]);
		if (!saved) return stale;
		const { terms, ...display } = derivedTerms(
			{ ...live, row: resolved.row },
			resolved.request,
			bound,
			feeds,
			saved.revision,
			now(),
		);
		const id = crypto.randomUUID();
		return {
			token: [id, terms, derivedSignature(id, terms, owner, live)].join("."),
			...display,
			acceptUnknown: false,
		};
	}

	/**
	 * The signature comes first and needs no row. A claimed Review then replays from storage, even
	 * after a re-pin removed or narrowed its row. Only a new claim resolves the current row,
	 * rebuilds and re-validates the body, and requires the reviewed terms.
	 */
	async function submitDerived(owner: string, input: DerivedLiveRequest) {
		const live = structuredClone(input);
		const match = typeof live.token === "string" && tokenFormat.exec(live.token);
		if (!match) return invalid;
		const [, id, terms, signed] = match;
		if (
			!timingSafeEqual(Buffer.from(signed), Buffer.from(derivedSignature(id, terms, owner, live)))
		)
			return invalid;
		const binding = digest("accepted-v1", signed, live.acceptUnknown);
		const existing = sql`SELECT binding FROM image_job WHERE id=${id}`;
		const replay = (row: { binding: string }) =>
			row.binding === binding ? { jobId: id } : invalid;
		const prior = await installation.use((db) => db.get<{ binding: string }>(existing));
		if (prior) return replay(prior);
		const resolved = resolveDerived(live, rows);
		if (!resolved) return stale;
		const { row, request } = resolved;
		const bound = wording(row);
		if (derivedBlocked(row, bound)) return invalid;
		const [saved, feeds] = await Promise.all([derivedCredential(live), loadFeeds(now())]);
		const claimed = await installation.use((db) =>
			db.transaction(
				async (tx) => {
					const concurrent = await tx.get<{ binding: string }>(existing);
					if (concurrent) return replay(concurrent);
					if (!saved) return stale;
					const current = await tx.get<{
						revision: number;
					}>(sql`SELECT c.revision FROM provider_credential c
						WHERE c.provider='poyo' AND c.ciphertext IS NOT NULL AND ${credentialPermitsImage(live.key.model)}`);
					if (current?.revision !== saved.revision) return stale;
					const time = now();
					const reviewed = derivedTerms(
						{ ...live, row },
						request,
						bound,
						feeds,
						saved.revision,
						time,
					);
					if (reviewed.terms !== terms) return stale;
					if (reviewed.requiresConsent && !live.acceptUnknown) return invalid;
					const until = await nextProviderStart(tx, "poyo", "submit", time);
					if (until > time) return { error: "cooldown" as const, until };
					const format = request.body.input.output_format;
					const contract = imageJobContract(
						row.key,
						row.contract,
						typeof format === "string" ? format : undefined,
					);
					await tx.run(sql`INSERT INTO image_job(id,binding,provider,revision,quote,accepted_unknown,state,created_at,model,operation,poll_deadline,contract)
						VALUES(${id},${binding},'poyo',${saved.revision},${JSON.stringify(reviewed.quote)},${Number(live.acceptUnknown)},'submitting',${time},${row.key.model},${row.key.operation},${time + imageJobPollingWindowMs},${contract})`);
					return { key: saved.key };
				},
				{ behavior: "immediate" },
			),
		);
		if (!("key" in claimed) || claimed.key === undefined) {
			if (!("error" in claimed) || claimed.error !== "stale") return claimed;
			const fresh = await reviewDerived(owner, live);
			return "token" in fresh ? { error: "stale" as const, review: fresh } : stale;
		}
		// Only the transaction that inserted the job can dispatch.
		await dispatch(id, "poyo", claimed.key, request);
		return { jobId: id };
	}

	function review(owner: string, live: DerivedLiveRequest): ReturnType<typeof reviewDerived>;
	function review(owner: string, live: LiveRequest): ReturnType<typeof reviewShipped>;
	function review(
		owner: string,
		live: LiveRequest | DerivedLiveRequest,
	): ReturnType<typeof reviewDerived> | ReturnType<typeof reviewShipped>;
	function review(owner: string, live: LiveRequest | DerivedLiveRequest) {
		return "derived" in live ? reviewDerived(owner, live) : reviewShipped(owner, live);
	}
	function submit(owner: string, live: DerivedLiveRequest): ReturnType<typeof submitDerived>;
	function submit(owner: string, live: LiveRequest): ReturnType<typeof submitShipped>;
	function submit(
		owner: string,
		live: LiveRequest | DerivedLiveRequest,
	): ReturnType<typeof submitDerived> | ReturnType<typeof submitShipped>;
	function submit(owner: string, live: LiveRequest | DerivedLiveRequest) {
		return "derived" in live ? submitDerived(owner, live) : submitShipped(owner, live);
	}
	return { review, submit };

	async function submitShipped(owner: string, input: LiveRequest) {
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
		if (blocked(live)) return invalid;

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
					// A ToAPIs claim re-reads its access in this transaction: only a fresh listing,
					// or the frozen exception before any snapshot, queues.
					const access: ModelAccess | null =
						provider === "toapis"
							? await inventoryAccess(
									tx,
									{
										origin: inventoryOrigin,
										scope: "image",
										key: live.entry.key,
										readable: saved.revision,
									},
									time,
								)
							: null;
					if (access && !accessQueues(access)) return stale;
					const reviewed = reviewTerms(live, feeds, saved.revision, time, access);
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
						// A Poyo.ai image job recovers from its stored contract; ToAPIs keeps the shipped path.
						const contract =
							provider === "poyo"
								? imageJobContract(
										live.entry.key,
										null,
										"outputFormat" in live.input ? live.input.outputFormat : undefined,
									)
								: null;
						await tx.run(sql`INSERT INTO image_job(id,binding,provider,revision,quote,accepted_unknown,state,created_at,model,operation,poll_deadline,contract)
					VALUES(${id},${binding},${provider},${saved.revision},${JSON.stringify(reviewed.quote)},${Number(live.acceptUnknown)},'submitting',${time},${live.input.model},${live.entry.key.operation},${time + imageJobPollingWindowMs},${contract})`);
					}
					return { key: saved.key, revision: saved.revision, deadline: time + 120_000, access };
				},
				{ behavior: "immediate" },
			),
		);
		if (!("key" in claimed) || claimed.key === undefined) {
			if (!("error" in claimed) || claimed.error !== "stale") return claimed;
			const fresh = await reviewShipped(owner, live, false);
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
				// The access evidence captured at claim: a later check does not stop this batch.
				checkTerms: async () => {
					const feeds = await loadFeeds(now());
					return () =>
						reviewTerms(live, feeds, claimed.revision, now(), claimed.access).terms === terms;
				},
			}).catch(() => console.error("Image batch dispatch interrupted."));
		} else await dispatch(id, provider, claimed.key, live.request);
		return { jobId: id };
	}
}
