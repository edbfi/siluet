import { createHmac, timingSafeEqual } from "node:crypto";
import { sql } from "drizzle-orm";
import {
	type DisclosedFile,
	fileByteLimit,
	fileDisclosure,
	fileUploadRoutes,
	neutralFilename,
} from "../../../shared/image-studio/file-edit";
import { createImageReview } from "../../../shared/image-studio/review";
import { estimateReviewPrice } from "../../../shared/image-studio/review-price";
import type { CleaningSetting } from "../../../shared/media-staging/cleaning";
import { idleMs, lifetimeMs } from "../../db/access-store";
import { claimFileSlots } from "../../db/file-attempt";
import { imageJobPollingWindowMs } from "../../db/image-job-schema";
import type { Installation, InstallationTransaction } from "../../db/installation";
import { mediaCleaning, readCleaningIn } from "../../db/media-cleaning";
import { nextPoyoUploadStart } from "../../db/poyo-upload-window";
import { submitCooldown } from "../../db/provider-gate";
import type { providerStore } from "../../db/provider-store";
import { cleanupRules } from "../media-cleanup/rules";
import {
	type FileStages,
	type OwnerScope,
	StageError,
	type StageMode,
} from "../media-staging/stages";
import { loadStudioPricingFeeds } from "../pricing/studio-feeds";
import { acceptedFileBinding, r1bReviewSignature, signedSlots } from "./accepted-binding";
import type { fileDispatcher } from "./dispatch";
import type { FileRequest } from "./request";
import { uploadSlot } from "./upload-slot";

const invalid = { error: "invalid" } as const;
const busy = { error: "busy" } as const;
const closing = { error: "closing" } as const;
// The provider key or the setting cannot be read. Preparing the files again would not help.
const unavailable = { error: "unavailable" } as const;
/** Slots to prepare again, or none when only the terms changed. */
const stale = (positions?: number[]) =>
	positions?.length ? ({ error: "stale", positions } as const) : ({ error: "stale" } as const);
type Answer =
	| { jobId: string }
	| typeof invalid
	| typeof busy
	| typeof closing
	| typeof unavailable
	| ReturnType<typeof stale>
	| { error: "cooldown"; until: number }
	| NonNullable<ReturnType<typeof limit>>;
// At most this many joined contenders re-enter admission after a winner rolled back.
const admissions = 3;

export type FileQueueOptions = {
	loadFeeds?: typeof loadStudioPricingFeeds;
	now?: () => number;
	readCleaning?: () => Promise<CleaningSetting>;
	/** The runtime's `siluet:stopping` signal: admission closes before storage does. */
	shutdown?: AbortSignal;
};

/** A staged copy agrees with the setting: cleaned while cleaning is on, original while off. */
const agrees = (setting: CleaningSetting, live: FileRequest) =>
	live.files.every(({ stage }) => setting.enabled === (stage.transform !== "original"));

/** The first file slot over the provider's byte limit, refused before anything is sent. */
function limit(live: FileRequest) {
	const provider = live.input.provider;
	const over = live.files.find(({ stage }) => stage.size > fileByteLimit[provider]);
	return over
		? ({
				error: "limit",
				provider,
				limit: fileByteLimit[provider],
				size: over.stage.size,
				position: over.position,
			} as const)
		: null;
}

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
		shutdown,
	}: FileQueueOptions = {},
) {
	const row = await db.use((tx) =>
		tx.get<{ secret: string }>(sql`SELECT secret FROM image_review_key WHERE singleton=1`),
	);
	if (!row) throw new Error("Review signing key unavailable.");
	const key = Buffer.from(row.secret, "hex");
	const mac = (...parts: unknown[]) =>
		createHmac("sha256", key).update(JSON.stringify(parts)).digest("hex");
	const signature = (id: string, terms: string, scope: OwnerScope, live: FileRequest) =>
		mac(
			"file-review-v3",
			id,
			terms,
			scope.owner,
			scope.session,
			signedSlots(live.slots),
			live.draft,
			live.request,
			1,
			0,
		);
	const poyoUploads = uploadSlot();
	/**
	 * The terms a file Review binds: the setting and its revision, every slot's rules and
	 * preparation, the disclosure, the price and each upload's wire. Files whose mode
	 * disagrees with the setting have none.
	 */
	function termsFor(
		live: FileRequest,
		revision: number,
		feeds: Awaited<ReturnType<typeof loadFeeds>>,
		setting: CleaningSetting,
		modes: readonly StageMode[],
	) {
		if (!agrees(setting, live)) return null;
		const provider = live.input.provider;
		const quote = estimateReviewPrice(
			feeds,
			createImageReview(live.input, live.request).pricing,
			{ count: 1, retryLimit: 0 },
			now(),
		);
		const files: DisclosedFile[] = live.files.map(({ position, stage }, index) => ({
			position,
			transform: stage.transform,
			rotated: stage.transform === "original" && modes[index].rotated,
		}));
		const disclosure = fileDisclosure(provider, files);
		return {
			quote,
			disclosure,
			terms: mac(
				"file-disclosure-v3",
				live.files.map(({ position, stage }) => [
					position,
					stage.transform === "original" ? cleanupRules.original : cleanupRules.cleaned,
					neutralFilename(stage.mime),
				]),
				{ enabled: setting.enabled, revision: setting.revision },
				revision,
				disclosure,
				quote,
				feeds[provider] ?? null,
				fileByteLimit[provider],
				["POST", fileUploadRoutes[provider], "Bearer", "multipart/form-data", "file", "default"],
				true,
			),
		};
	}
	const authenticated = (
		scope: OwnerScope,
		time: number,
	) => sql`EXISTS(SELECT 1 FROM session JOIN owner ON session.owner_id=owner.id
		JOIN owner_security ON singleton=1 AND recovery_required=0
		WHERE digest=${scope.session} AND owner.id=1 AND username=${scope.owner}
		AND last_activity BETWEEN ${time - idleMs + 1} AND ${time} AND session.created_at BETWEEN ${time - lifetimeMs + 1} AND ${time})`;
	/** A provider cooldown, or the Poyo.ai window too full for this job's uploads. */
	async function blockedUntil(
		tx: Pick<InstallationTransaction, "get">,
		provider: FileRequest["input"]["provider"],
		uploads: number,
		time: number,
	) {
		return Math.max(
			await submitCooldown(tx as InstallationTransaction, provider),
			provider === "poyo" ? await nextPoyoUploadStart(tx, time, uploads) : 0,
		);
	}
	const active = new Set<Promise<unknown>>();
	// Identical authenticated first uses share one admission and one answer.
	const admitting = new Map<string, Promise<Answer>>();
	let closed = !!shutdown?.aborted;
	shutdown?.addEventListener(
		"abort",
		() => {
			closed = true;
		},
		{ once: true },
	);
	function supervise<T>(work: Promise<T>) {
		active.add(work);
		void work.then(
			() => active.delete(work),
			() => active.delete(work),
		);
		return work;
	}
	async function submit(scope: OwnerScope, live: FileRequest): Promise<Answer> {
		if (typeof live.token !== "string") return invalid;
		const match = /^(file[23])\.([0-9a-f-]{36})\.([a-f0-9]{64})\.([a-f0-9]{64})$/.exec(live.token);
		// The token's prefix names its body: R1b's single file, or ordered slots.
		if (!match || match[1] !== `file${live.version}` || !live.acceptUnknown) return invalid;
		const [, , id, terms, signed] = match;
		const binding = acceptedFileBinding(mac, scope.owner, live.token, live);
		const lookup = () =>
			db.use((tx) =>
				tx.get<{ binding: string; active: number }>(
					sql`SELECT binding,${authenticated(scope, now())} AS active FROM image_job WHERE id=${id} AND file_phase IS NOT NULL`,
				),
			);
		// An identical replay of a claimed Review needs a live session and the exact accepted
		// binding. It is answered before the setting or scratch is read, so it survives a
		// later setting change, expiry, restart and upgrade.
		const replay = (previous: { binding: string; active: number }) =>
			previous.active && previous.binding === binding ? { jobId: id } : invalid;
		const prior = await lookup();
		if (prior) return replay(prior);
		const verifies = (expected: string) =>
			timingSafeEqual(Buffer.from(signed), Buffer.from(expected));
		// The upgrade retired every R1b stage, so an unused R1b Review can only be stale.
		if (live.version === 2)
			return verifies(r1bReviewSignature(mac, id, terms, scope.owner, scope.session, live))
				? stale()
				: invalid;
		if (!verifies(signature(id, terms, scope, live))) return invalid;
		const key = `${id}\n${binding}`;
		const shared = admitting.get(key);
		if (shared) return shared;
		const admission = (async () => {
			// Before answering any refusal, a winner that committed meanwhile is replayed.
			const refuse = async (answer: Answer) => {
				const winner = await lookup();
				return winner ? replay(winner) : answer;
			};
			for (let attempt = 0; attempt < admissions; attempt++) {
				if (closed) return refuse(closing);
				const tooLarge = limit(live);
				if (tooLarge) return tooLarge;
				const provider = live.input.provider;
				const saved = await credential(provider);
				if (!saved) return refuse(unavailable);
				if (!(await readCleaning().catch(() => null))) return refuse(unavailable);
				const uploads = live.files.length;
				const preclaim = await db.use((tx) => blockedUntil(tx, provider, uploads, now()));
				if (preclaim > now()) return refuse({ error: "cooldown", until: preclaim });
				let refused: Answer = stale();
				try {
					const feeds = await loadFeeds(now());
					const claim = await stages.claimAll(
						scope,
						live.files.map(({ stage }) => stage),
						binding,
						(valid, durable, modes) =>
							db.use((tx) =>
								durable(() =>
									tx.transaction(
										async (trx) => {
											const time = now();
											// The setting is read again inside the claim, against each stage's own revision.
											const setting = await readCleaningIn(trx).catch(() => null);
											if (!setting) {
												refused = unavailable;
												return false;
											}
											const mismatched = live.files.flatMap(({ position }, index) =>
												modes[index].revision === setting.revision ? [] : [position],
											);
											if (mismatched.length) {
												refused = stale(mismatched);
												return false;
											}
											const termsNow = termsFor(live, saved.revision, feeds, setting, modes);
											if (termsNow?.terms !== terms) {
												refused = stale();
												return false;
											}
											if (closed) {
												refused = closing;
												return false;
											}
											if (!valid()) return false;
											const until = await blockedUntil(trx, provider, uploads, time);
											if (until > time) {
												refused = { error: "cooldown", until };
												return false;
											}
											const inserted =
												await trx.get(sql`INSERT INTO image_job(id,binding,provider,revision,quote,accepted_unknown,state,created_at,model,operation,poll_deadline,file_owner,file_phase)
								SELECT ${id},${binding},${provider},${saved.revision},${JSON.stringify(termsNow.quote)},1,'submitting',${time},${live.input.model},${live.entry.key.operation},${time + imageJobPollingWindowMs},${nonce},'claimed'
								WHERE EXISTS(SELECT 1 FROM provider_credential WHERE provider=${provider} AND revision=${saved.revision} AND seedream=1 AND ciphertext IS NOT NULL)
								AND ${authenticated(scope, time)} RETURNING id`);
											if (!inserted) return false;
											await claimFileSlots(
												trx,
												id,
												live.files.map(({ position }) => position),
												live.slots.length,
											);
											// After the last write: an expiry or a shutdown during the writes rolls back.
											if (!valid()) throw new StageError("Review expired.");
											if (closed) {
												refused = closing;
												throw new StageError("Shutting down.");
											}
											return true;
										},
										{ behavior: "immediate" },
									),
								),
							),
						provider === "poyo" ? poyoUploads.take : undefined,
					);
					if ("held" in claim) {
						supervise(dispatch(id, saved.key, live, claim.held, () => closed));
						return { jobId: id };
					}
					// The identical winner rolled back without a job: admit again.
					if ("joined" in claim) {
						const winner = await lookup();
						if (winner) return replay(winner);
						continue;
					}
					if ("stale" in claim)
						return refuse(stale(claim.stale.map((index) => live.files[index].position)));
				} catch (error) {
					if (error instanceof StageError && error.message === "Upload busy · nothing sent")
						return refuse(busy);
					if (!(error instanceof StageError)) throw error;
				}
				return refuse(refused);
			}
			return refuse(busy);
		})();
		admitting.set(key, admission);
		try {
			return await admission;
		} finally {
			admitting.delete(key);
		}
	}
	return {
		async review(scope: OwnerScope, live: FileRequest) {
			if (closed) return closing;
			// R1b's single-file Review is gone; open tabs reload to review files.
			if (live.version !== 3) return invalid;
			if (typeof live.token === "string" && live.token.startsWith("file2.")) return invalid;
			const tooLarge = limit(live);
			if (tooLarge) return tooLarge;
			const provider = live.input.provider;
			const [saved, feeds, setting] = await Promise.all([
				credential(provider),
				loadFeeds(now()),
				readCleaning().catch(() => null),
			]);
			if (!saved || !setting) return unavailable;
			const result = await stages.reviewAll(
				scope,
				live.files.map(({ stage }) => stage),
				setting.revision,
			);
			if ("stale" in result) return stale(result.stale.map((index) => live.files[index].position));
			const files = live.files.map((file, index) => ({
				...file,
				stage: result.reviewed[index].descriptor,
			}));
			const reviewed: FileRequest = {
				...live,
				files,
				slots: live.slots.map((slot, index) => {
					const file = files.find(({ position }) => position === index + 1);
					return file ? { kind: "file", stage: file.stage } : slot;
				}),
			};
			const terms = termsFor(reviewed, saved.revision, feeds, setting, result.reviewed);
			if (!terms) return stale(files.map(({ position }) => position));
			const id = crypto.randomUUID();
			return {
				files: files.map(({ position, stage }) => ({ position, stage })),
				token: ["file3", id, terms.terms, signature(id, terms.terms, scope, reviewed)].join("."),
				quote: terms.quote,
				editDisclosure: terms.disclosure,
				requiresConsent: true,
				acceptUnknown: false,
			};
		},
		// While shutting down, Queue sends nothing and answers `closing`, never a refusal,
		// so a Retry of a claimed request stays available for after the restart.
		submit: (scope: OwnerScope, live: FileRequest) =>
			closed ? Promise.resolve(closing) : supervise(submit(scope, live)),
		async close() {
			closed = true;
			while (active.size) await Promise.allSettled(active);
		},
	};
}
export type FileQueue = Awaited<ReturnType<typeof createFileQueue>>;
