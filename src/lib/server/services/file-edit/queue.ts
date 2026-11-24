import { createHmac, timingSafeEqual } from "node:crypto";
import { sql } from "drizzle-orm";
import {
	fileByteLimit,
	fileDisclosure,
	fileUploadRoutes,
	neutralFilename,
	originalRotationNote,
} from "../../../shared/image-studio/file-edit";
import { createImageReview } from "../../../shared/image-studio/review";
import { estimateReviewPrice } from "../../../shared/image-studio/review-price";
import type { CleaningSetting } from "../../../shared/media-staging/cleaning";
import type { ImageTransform } from "../../../shared/media-staging/descriptor";
import { idleMs, lifetimeMs } from "../../db/access-store";
import { claimFileSlots } from "../../db/file-attempt";
import { imageJobPollingWindowMs } from "../../db/image-job-schema";
import type { Installation } from "../../db/installation";
import { mediaCleaning, readCleaningIn } from "../../db/media-cleaning";
import { nextPoyoUploadStart } from "../../db/poyo-upload-window";
import { submitCooldown } from "../../db/provider-gate";
import type { providerStore } from "../../db/provider-store";
import { cleanupRules } from "../media-cleanup/rules";
import { type FileStages, StageError, type StageScope } from "../media-staging/stages";
import { loadStudioPricingFeeds } from "../pricing/studio-feeds";
import { acceptedFileBinding } from "./accepted-binding";
import type { fileDispatcher } from "./dispatch";
import type { FileRequest } from "./request";

const invalid = { error: "invalid" } as const;
const stale = { error: "stale" } as const;
const busy = { error: "busy" } as const;
const closing = { error: "closing" } as const;
// The provider key or the setting cannot be read. Preparing the file again would not help.
const unavailable = { error: "unavailable" } as const;
type Mode = { setting: CleaningSetting; transform: ImageTransform; rotated: boolean };

/** A staged copy agrees with the setting: cleaned while cleaning is on, original while off. */
const agrees = ({ setting, transform }: Mode) => setting.enabled === (transform !== "original");

export type FileQueueOptions = {
	loadFeeds?: typeof loadStudioPricingFeeds;
	now?: () => number;
	readCleaning?: () => Promise<CleaningSetting>;
};

export async function createFileQueue(
	db: Installation,
	nonce: string,
	stages: FileStages,
	credential: ReturnType<typeof providerStore>["credential"],
	dispatch: ReturnType<typeof fileDispatcher>,
	{
		loadFeeds = loadStudioPricingFeeds,
		now = Date.now,
		readCleaning = mediaCleaning(db).read,
	}: FileQueueOptions = {},
) {
	const row = await db.use((tx) =>
		tx.get<{ secret: string }>(sql`SELECT secret FROM image_review_key WHERE singleton=1`),
	);
	if (!row) throw new Error("Review signing key unavailable.");
	const key = Buffer.from(row.secret, "hex");
	const mac = (...parts: unknown[]) =>
		createHmac("sha256", key).update(JSON.stringify(parts)).digest("hex");
	const signature = (id: string, terms: string, scope: StageScope, live: FileRequest) => {
		const { draft, handle, digest, mime, transform, size, deadline } = live.stage;
		return mac(
			"file-review-v2",
			id,
			terms,
			scope.owner,
			scope.session,
			scope.draft,
			{ draft, handle, digest, mime, transform, size, deadline },
			live.draft,
			live.request,
			1,
			0,
		);
	};
	/**
	 * The terms a file Review binds: the setting and its revision, the rules and
	 * disclosure for the staged copy's mode, the price and the upload wire. A copy whose
	 * mode disagrees with the setting has none.
	 */
	function termsFor(
		live: FileRequest,
		revision: number,
		feeds: Awaited<ReturnType<typeof loadFeeds>>,
		mode: Mode,
	) {
		if (!agrees(mode)) return null;
		const provider = live.input.provider;
		const original = mode.transform === "original";
		const quote = estimateReviewPrice(
			feeds,
			createImageReview(live.input, live.request).pricing,
			{ count: 1, retryLimit: 0 },
			now(),
		);
		const disclosure = [
			...fileDisclosure(provider, mode.transform),
			...(original && mode.rotated ? [originalRotationNote] : []),
		];
		return {
			quote,
			disclosure,
			terms: mac(
				original ? cleanupRules.original : cleanupRules.cleaned,
				"file-disclosure-v2",
				{ enabled: mode.setting.enabled, revision: mode.setting.revision },
				revision,
				disclosure,
				quote,
				feeds[provider] ?? null,
				fileByteLimit[provider],
				[
					"POST",
					fileUploadRoutes[provider],
					"Bearer",
					"multipart/form-data",
					"file",
					neutralFilename(live.stage.mime),
					"default",
				],
				true,
			),
		};
	}
	const limit = (live: FileRequest) => {
		const provider = live.input.provider;
		return live.stage.size > fileByteLimit[provider]
			? ({
					error: "limit",
					provider,
					limit: fileByteLimit[provider],
					size: live.stage.size,
				} as const)
			: null;
	};
	const active = new Set<Promise<unknown>>();
	let closed = false;
	function supervise<T>(work: Promise<T>) {
		active.add(work);
		void work.then(
			() => active.delete(work),
			() => active.delete(work),
		);
		return work;
	}
	async function submit(scope: StageScope, live: FileRequest) {
		if (typeof live.token !== "string") return invalid;
		const match = /^file2\.([0-9a-f-]{36})\.([a-f0-9]{64})\.([a-f0-9]{64})$/.exec(live.token);
		if (!match || !live.acceptUnknown || live.stage.draft !== scope.draft) return invalid;
		const [, id, terms, signed] = match;
		const firstUseSignature = () =>
			timingSafeEqual(Buffer.from(signed), Buffer.from(signature(id, terms, scope, live)));
		const binding = acceptedFileBinding(mac, scope.owner, live.token, live);
		const authenticated = (
			time: number,
		) => sql`EXISTS(SELECT 1 FROM session JOIN owner ON session.owner_id=owner.id
			JOIN owner_security ON singleton=1 AND recovery_required=0
			WHERE digest=${scope.session} AND owner.id=1 AND username=${scope.owner}
			AND last_activity BETWEEN ${time - idleMs + 1} AND ${time} AND session.created_at BETWEEN ${time - lifetimeMs + 1} AND ${time})`;
		const lookup = () =>
			db.use((tx) =>
				tx.get<{ binding: string; active: number }>(
					sql`SELECT binding,${authenticated(now())} AS active FROM image_job WHERE id=${id} AND file_phase IS NOT NULL`,
				),
			);
		// An identical replay of a claimed Review is answered before the setting or
		// scratch is read, so it survives a later setting change, expiry and restart.
		const replay = (previous: { binding: string; active: number }) =>
			previous.active && previous.binding === binding ? { jobId: id } : invalid;
		const prior = await lookup();
		if (prior) return replay(prior);
		if (!firstUseSignature()) return invalid;
		const provider = live.input.provider;
		if (closed) return closing;
		const tooLarge = limit(live);
		if (tooLarge) return tooLarge;
		const saved = await credential(provider);
		if (!saved) {
			const winner = await lookup();
			return winner ? replay(winner) : unavailable;
		}
		try {
			let cooldown = 0;
			const claim = await stages.claimAll(
				scope,
				[live.stage],
				binding,
				async (valid, durable, [stage]) => {
					const feeds = await loadFeeds(now());
					return db.use((tx) =>
						durable(() =>
							tx.transaction(
								async (trx) => {
									const time = now();
									// The setting is read again inside the claim, with the stage's own revision.
									const setting = await readCleaningIn(trx);
									if (setting.revision !== stage.revision) return false;
									const termsNow = termsFor(live, saved.revision, feeds, {
										setting,
										transform: live.stage.transform,
										rotated: stage.rotated,
									});
									if (termsNow?.terms !== terms || closed || !valid()) return false;
									cooldown = Math.max(
										await submitCooldown(trx, provider),
										provider === "poyo" ? await nextPoyoUploadStart(trx, time) : 0,
									);
									if (cooldown > time) return false;
									const inserted =
										await trx.get(sql`INSERT INTO image_job(id,binding,provider,revision,quote,accepted_unknown,state,created_at,model,operation,poll_deadline,file_owner,file_phase)
						SELECT ${id},${binding},${provider},${saved.revision},${JSON.stringify(termsNow.quote)},1,'submitting',${time},${live.input.model},${live.entry.key.operation},${time + imageJobPollingWindowMs},${nonce},'claimed'
						WHERE EXISTS(SELECT 1 FROM provider_credential WHERE provider=${provider} AND revision=${saved.revision} AND seedream=1 AND ciphertext IS NOT NULL)
						AND ${authenticated(time)} RETURNING id`);
									if (inserted && !valid()) throw new StageError("Review expired.");
									if (inserted) await claimFileSlots(trx, id, [1], 1);
									return !!inserted;
								},
								{ behavior: "immediate" },
							),
						),
					);
				},
			);
			if ("held" in claim) {
				const { held } = claim;
				const bytes = await held.next(0);
				supervise(dispatch(id, saved.key, live, { bytes, release: () => void held.release() }));
				return { jobId: id };
			}
			if (cooldown > now()) return { error: "cooldown", until: cooldown } as const;
		} catch (error) {
			if (error instanceof StageError && error.message === "Upload busy · nothing sent")
				return busy;
			if (!(error instanceof StageError)) throw error;
		}
		const winner = await lookup();
		return winner ? replay(winner) : stale;
	}
	return {
		async review(scope: StageScope, live: FileRequest) {
			if (closed) return closing;
			if (live.stage.draft !== scope.draft) return stale;
			const tooLarge = limit(live);
			if (tooLarge) return tooLarge;
			const provider = live.input.provider;
			const [saved, feeds, setting] = await Promise.all([
				credential(provider),
				loadFeeds(now()),
				readCleaning().catch(() => null),
			]);
			if (!saved || !setting) return unavailable;
			const reviewed = await stages.review(scope, live.stage.handle, live.stage);
			if (!reviewed || reviewed.revision !== setting.revision) return stale;
			const { descriptor: stage, rotated } = reviewed;
			const terms = termsFor({ ...live, stage }, saved.revision, feeds, {
				setting,
				transform: stage.transform,
				rotated,
			});
			if (!terms) return stale;
			const id = crypto.randomUUID();
			return {
				stage,
				token: [
					"file2",
					id,
					terms.terms,
					signature(id, terms.terms, scope, { ...live, stage }),
				].join("."),
				quote: terms.quote,
				editDisclosure: terms.disclosure,
				requiresConsent: true,
				acceptUnknown: false,
			};
		},
		// While shutting down, Queue sends nothing and answers `closing`, never a refusal,
		// so a Retry of a claimed request stays available for after the restart.
		submit: (scope: StageScope, live: FileRequest) =>
			closed ? Promise.resolve(closing) : supervise(submit(scope, live)),
		async close() {
			closed = true;
			while (active.size) await Promise.allSettled(active);
		},
	};
}
export type FileQueue = Awaited<ReturnType<typeof createFileQueue>>;
