import { sql } from "drizzle-orm";
import type { ProviderId } from "../../../shared/providers/connections";
import type { FileSlotRow } from "../../db/file-attempt";
import { type BatchStop, imageBatchStore, retryStillSupported } from "../../db/image-batch-store";
import {
	hasCorrelation,
	type ImageJob,
	imageJobStore,
	isReadPaused,
	isVideoJob,
	jobCredentialAccess,
	jobPollDeadline,
	type StatusNote,
	skipImageSend,
} from "../../db/image-job-store";
import type { Installation } from "../../db/installation";
import { retryTime } from "../../db/provider-gate";
import type { providerStore } from "../../db/provider-store";
import type { CheckFetch } from "../../providers/connection-check";
import {
	type ReviewedImageRequest,
	statusTimeoutMs,
	type TaskObservation,
} from "../../providers/image-job";
import { createPoyoImage } from "../../providers/poyo/image";
import { createPoyoVideo } from "../../providers/poyo/video";
import { createToapisImage } from "../../providers/toapis/image";
import { createToapisVideo } from "../../providers/toapis/video";
import { type BatchAuthorization, dispatchBatch } from "../queue/batch-dispatch";
import { contractReader } from "../queue/contract";
import { createSubmitGate } from "../queue/submit-gate";
import type { VideoTarget } from "../queue/video";
import type { VideoDelivery } from "../video-media/download";
import { batchHistory } from "./batch-history";
import { retryEvidence, statusUpdate } from "./observation";
import { type GalleryState, isActive, summarizeJob } from "./summary";

export type { JobSummary } from "./summary";

/** What a status read for automatic Save found (D9). `failed` ends in Download failed. */
export type SaveRead =
	| { kind: "delivered"; delivery: VideoDelivery }
	| { kind: "cooldown"; until: number }
	| { kind: "paused"; note: StatusNote }
	| { kind: "expired" }
	| { kind: "failed" };

/**
 * Hands a completed result to automatic Save: a first completion's intent with its link, or a
 * pending intent that resumes with any link. A link-less first completion already holds Download failed.
 */
export type DeliveryHandoff = (id: string, delivery: VideoDelivery | null) => unknown;

/** Jobs and their file slots from one read. */
type Snapshot = { jobs: ImageJob[]; slots: FileSlotRow[] };
type JobCredentials = Pick<ReturnType<typeof providerStore>, "credential" | "jobReadability">;
type TrackingDependencies = {
	fetch?: CheckFetch;
	now?: () => number;
	random?: () => number;
	sleep?: (delay: number) => Promise<void>;
	scheduleRead?: typeof scheduleReadTimer;
	onDelivery?: DeliveryHandoff;
};
/** A status read that ran, with any usable result link, or none when it was not allowed. */
type Observed = { delivery: VideoDelivery | null } | null;

function scheduleReadTimer(read: () => Promise<void>, delay: number) {
	const timer = setTimeout(() => void read(), delay).unref();
	return () => clearTimeout(timer);
}

const initialWait = { poyo: 2_000, toapis: 5_000 };
// The query gate's span: a refused read for automatic Save looks again after it.
const saveReadRetryMs = 1_000;
const intervalJitter = { poyo: 3_000, toapis: 5_000 };

function autoTrack(job: ImageJob) {
	if (job.pause_reason === "credential-changed") return false;
	return (
		(isActive(job) && !isReadPaused(job.pause_reason)) ||
		job.retry_state === "watch" ||
		job.retry_state === "settlement"
	);
}

export function createJobTracking(
	installation: Installation,
	credentials: JobCredentials,
	{
		fetch: read,
		now = Date.now,
		random = Math.random,
		sleep = (delay) => new Promise((resolve) => setTimeout(resolve, delay).unref()),
		scheduleRead = scheduleReadTimer,
		onDelivery,
	}: TrackingDependencies = {},
) {
	const store = imageJobStore(installation);
	const batches = imageBatchStore(installation);
	const gatedSend = createSubmitGate(installation, now, random);
	const video = createToapisVideo(read);
	const poyo = createPoyoImage(read);
	const poyoVideo = createPoyoVideo(read);
	const adapters = { poyo, toapis: createToapisImage(read) };
	const timers = new Map<string, () => void>();
	const inFlight = new Map<string, Promise<Observed>>();
	let start: Promise<void> | undefined;
	let closed = false;
	// close() ends every dispatch sleep at once. Each sender checks `closed` after waking.
	const shutdown = Promise.withResolvers<void>();
	const pause = (delay: number) => Promise.race([sleep(delay), shutdown.promise]);

	function cancelTimer(id: string) {
		timers.get(id)?.();
		timers.delete(id);
	}

	function schedule(job: ImageJob, earliest = 0) {
		cancelTimer(job.id);
		if (closed || !autoTrack(job) || job.next_read_at === null) return;
		const due = Math.max(job.next_read_at, earliest);
		const deadline = jobPollDeadline(job);
		if (due >= deadline || now() >= deadline) return;
		const cancel = scheduleRead(
			async () => {
				timers.delete(job.id);
				await readStatus(job.id, true, false, true).catch(() =>
					schedule(job, now() + initialWait[job.provider]),
				);
			},
			Math.max(0, due - now()),
		);
		timers.set(job.id, cancel);
	}

	async function originalKey(job: ImageJob) {
		return (await credentials.credential(job.provider, job.revision, jobCredentialAccess(job)))
			?.key;
	}

	async function afterBalance(job: ImageJob) {
		if (!job.wallet_open || job.provider !== "poyo") return;
		const key = await originalKey(job);
		const balance =
			key && job.wallet_finish_by !== null && now() < job.wallet_finish_by
				? await poyo.balance(key)
				: null;
		await store.finishWallet(job.id, balance, now());
	}

	// Signed links stay in memory: the handoff never waits for Save and never persists them.
	function handOff(id: string, delivery: VideoDelivery | null) {
		if (closed || !onDelivery) return;
		queueMicrotask(() => {
			try {
				void Promise.resolve(onDelivery(id, delivery)).catch(() => {});
			} catch {}
		});
	}

	async function observe(
		id: string,
		automatic: boolean,
		lookup: boolean,
		handoff: boolean,
	): Promise<Observed> {
		const job = await store.get(id);
		if (
			closed ||
			!job ||
			(lookup ? !hasCorrelation(job) || job.state !== "unknown" || job.task_id : !job.task_id) ||
			(job.next_read_at ?? job.created_at + 5000) > now()
		)
			return null;
		if (automatic && (!autoTrack(job) || now() >= jobPollDeadline(job))) return null;

		const key = await originalKey(job);
		if (closed) return null;
		if (!key) {
			await store.recordMissingCredential(id);
			return null;
		}

		const token = crypto.randomUUID();
		// The durable reservation covers a read interrupted by a restart before its cooldown is known.
		const holdMs = statusTimeoutMs + initialWait[job.provider] + intervalJitter[job.provider];
		const reserved = await store.reserveRead(
			id,
			token,
			now,
			holdMs,
			automatic,
			lookup ? job : undefined,
		);
		if (closed || !reserved) return null;
		if (automatic && now() >= jobPollDeadline(reserved)) {
			await store.releaseUnread(id, token, job.next_read_at ?? now() + holdMs);
			return null;
		}

		const correlation =
			reserved.provider === "toapis" && isVideoJob(reserved) ? reserved.business_id : null;
		const videoRead =
			correlation === null ? null : await video.status(key, correlation, reserved.task_id);
		// A contract written by a newer adapter version is held rather than read as this one.
		const held = !isVideoJob(reserved) && contractReader(reserved.contract) === "held";
		const observation: TaskObservation = held
			? { kind: "paused", reason: "held-contract", retryAfter: null }
			: (videoRead ??
				(await (isVideoJob(reserved) ? poyoVideo : adapters[job.provider]).status(
					key,
					reserved.task_id ?? "",
				)));
		const finished = now();
		const interval =
			initialWait[job.provider] + Math.floor(random() * (intervalJitter[job.provider] + 1));
		const { update, resultUrl } = statusUpdate(reserved, observation, finished, interval);
		const retry =
			automatic && reserved.retry_state
				? retryEvidence(reserved, observation, update.billing, finished, random)
				: null;
		const recorded = await store.recordStatus(reserved, token, finished, {
			...update,
			retry,
			lookup,
			progress: videoRead?.progress,
			recoveredTask: lookup ? videoRead?.taskId : undefined,
			queryAfter: Math.max(
				observation.queryAfter ?? 0,
				observation.kind === "temporary" ? retryTime(observation.retryAfter, finished) : 0,
			),
		});

		if (!recorded) {
			if (lookup && videoRead?.taskId) await store.identityConflict(id, videoRead.taskId);
			return null;
		}
		const { job: saved, armed, pending, resumed } = recorded;
		const delivery = resultUrl ? { url: resultUrl, fallback: videoRead?.fallback ?? null } : null;
		// Commit first, then hand over: a first completion always, a waiting intent when this
		// read brought a link or ended a read pause. Refresh on any other completed job does nothing.
		if (handoff && (armed || (pending && (delivery || resumed)))) handOff(id, delivery);
		if (isActive(reserved) && (saved.state === "completed" || saved.state === "failed"))
			await finishBalance(saved);
		return { delivery };
	}

	function readStatus(id: string, automatic: boolean, lookup: boolean, handoff: boolean) {
		const active = inFlight.get(id);
		if (active) return active;
		const operation = observe(id, automatic, lookup, handoff)
			.then(async (observed) => {
				const job = await store.get(id);
				if (job) schedule(job);
				return observed;
			})
			.finally(() => inFlight.delete(id));
		inFlight.set(id, operation);
		return operation;
	}

	async function finishBatchWallet(id: string) {
		const owner = await batches.claimAfter(id, now());
		if (owner) await afterBalance(owner);
	}
	async function finishBalance(job: ImageJob) {
		if (job.batch_id) await finishBatchWallet(job.batch_id);
		else await afterBalance(job);
	}
	async function send(
		id: string,
		provider: ProviderId,
		key: string,
		request: ReviewedImageRequest,
		attempt: number,
		before: boolean,
		auth?: BatchAuthorization,
	): Promise<BatchStop | undefined> {
		if (before) await store.recordBefore(id, await poyo.balance(key), now());
		const deadline = auth?.deadline ?? Infinity;
		for (;;) {
			if (closed) return "interrupted";
			let retryConflict = false;
			const response = await gatedSend(
				provider,
				deadline,
				attempt,
				() => adapters[provider].submit(key, request),
				{
					allowed: async (tx) => {
						if (closed) return false;
						if (!auth) return true;
						if (
							!(await tx.get(
								sql`SELECT 1 FROM image_batch WHERE id=${auth.id} AND closed_reason IS NULL`,
							))
						)
							return false;
						retryConflict = attempt > 1 && !(await retryStillSupported(tx, id));
						return !retryConflict;
					},
					blocked: async (tx, reason, until) => {
						if (auth && reason === "cooldown" && until !== null && until < deadline) return;
						await skipImageSend(tx, id, retryConflict ? "retry-evidence" : reason, now(), until);
					},
				},
			);
			if ("blocked" in response) {
				if (retryConflict) return;
				if (auth && response.blocked === "cooldown" && response.until < deadline) {
					await pause(Math.max(1, response.until - now()));
					continue;
				}
				return response.blocked;
			}
			const job = await store.recordSubmission(
				id,
				response.result,
				now(),
				initialWait[provider],
				response.retryAt,
			);
			if (job) {
				if (job.state === "rejected") await finishBalance(job);
				schedule(job);
			}
			return response.result.kind === "rejected" ? "rejection" : undefined;
		}
	}

	// Dispatches still running, so close() can wait for them before storage closes.
	const dispatches = new Set<Promise<unknown>>();
	function supervise<T>(work: Promise<T>) {
		dispatches.add(work);
		void work.then(
			() => dispatches.delete(work),
			() => dispatches.delete(work),
		);
		return work;
	}

	async function summarize({ jobs: rows, slots: slotRows }: Snapshot) {
		const readable = rows.some((job) => job.task_id || hasCorrelation(job))
			? await credentials.jobReadability()
			: () => false;
		const gallery = new Map(
			(
				await installation.use((db) =>
					db.all<{ job_id: string; state: Exclude<GalleryState, null> }>(
						sql`SELECT job_id, state FROM gallery_image`,
					),
				)
			).map((row) => [row.job_id, row.state]),
		);
		const slots = Map.groupBy(slotRows, (slot) => slot.job_id);
		return rows.map((job) =>
			summarizeJob(
				job,
				readable(job),
				now(),
				gallery.get(job.id) ?? null,
				slots.get(job.id)?.map(({ position, outcome }) => ({ position, outcome })),
			),
		);
	}

	const runners = {
		async dispatchVideo(id: string, key: string, target: VideoTarget) {
			const { provider } = target;
			if (closed || !(await store.beginDispatch(id, provider, now()))) return;
			// A Poyo wallet interval opens with a before-read on the claimed key.
			if (provider === "poyo") await store.recordBefore(id, await poyo.balance(key), now());
			const response = await gatedSend(
				provider,
				Infinity,
				1,
				() =>
					target.provider === "poyo"
						? poyoVideo.submit(key, target.body)
						: video.submit(key, target.body, target.business),
				{
					allowed: async (tx) =>
						!closed &&
						!!(await tx.get(
							sql`SELECT 1 FROM image_job j JOIN provider_credential c ON c.provider=j.provider AND c.revision=j.revision WHERE j.id=${id} AND j.state='submitting' AND c.ciphertext IS NOT NULL AND j.submission_recorded_at IS NULL`,
						)),
					// An unsent job closes its wallet interval without an after-read.
					blocked: (tx, reason, until) => skipImageSend(tx, id, reason, now(), until),
				},
			);
			if ("blocked" in response) return;
			const { result } = response;
			const job = await store.recordSubmission(
				id,
				result,
				now(),
				initialWait[provider],
				response.retryAt,
			);
			if (job) {
				if (job.state === "rejected") await finishBalance(job);
				schedule(job);
			} else if (provider === "toapis" && result.kind === "accepted")
				await store.identityConflict(id, result.taskId);
		},
	};

	async function dispatchAll(auth: BatchAuthorization) {
		let reason: BatchStop = "interrupted";
		try {
			reason = await dispatchBatch(
				auth,
				batches,
				(id, attempt, before) =>
					send(id, auth.provider, auth.key, auth.request, attempt, before, auth),
				now,
				pause,
				() => closed,
			);
		} finally {
			if (!closed) {
				await batches.close(auth.id, reason, now());
				await finishBatchWallet(auth.id);
			}
		}
	}

	return {
		dispatchVideo: (...args: Parameters<typeof runners.dispatchVideo>) =>
			supervise(runners.dispatchVideo(...args)),
		/** Track a job a file dispatcher recorded, as Queue does for its own submissions. */
		schedule: (job: ImageJob) => schedule(job),
		async lookup(id: string) {
			await readStatus(id, false, true, true);
		},
		/**
		 * One status read on behalf of automatic Save, under the same cooldown, provider gate
		 * and key as Refresh. It never submits and hands nothing over itself.
		 */
		async readForSave(id: string): Promise<SaveRead> {
			const blocker = async (): Promise<SaveRead | null> => {
				const job = await store.get(id);
				if (job?.state !== "completed") return { kind: "failed" };
				if (job.expires_at !== null && job.expires_at <= now()) return { kind: "expired" };
				if (isReadPaused(job.pause_reason)) return { kind: "paused", note: job.pause_reason };
				if (!(await credentials.jobReadability())(job))
					return { kind: "paused", note: "credential-changed" };
				const until = job.next_read_at ?? 0;
				return until > now() ? { kind: "cooldown", until } : null;
			};
			// A read already in flight (Refresh or polling) is shared, as for any other reader.
			const before = inFlight.has(id) ? null : await blocker();
			const sharing = inFlight.get(id);
			if (before && !sharing) return before;
			// Shutdown: give the attempt back without a try.
			if (closed) return { kind: "cooldown", until: now() };
			const observed = await (sharing ?? readStatus(id, false, false, false));
			if (observed?.delivery) return { kind: "delivered", delivery: observed.delivery };
			const after = await blocker();
			// A read that ran without a usable link fails, even inside its new cooldown.
			if (observed) return !after || after.kind === "cooldown" ? { kind: "failed" } : after;
			// No read ran (the provider gate refused it, even if it has opened since): wait without a try.
			return after ?? { kind: "cooldown", until: now() + saveReadRetryMs };
		},
		dispatch: (id: string, provider: ProviderId, key: string, request: ReviewedImageRequest) =>
			supervise(
				(async () => {
					if (closed || !(await store.beginDispatch(id, provider, now()))) return;
					await send(id, provider, key, request, 1, provider === "poyo");
				})(),
			),
		dispatchBatch: (auth: BatchAuthorization) => supervise(dispatchAll(auth)),
		batches: batches.list,

		resume() {
			start ??= (async () => {
				await store.recover(now());
				for (const job of await store.list()) schedule(job);
				for (const batch of await batches.list()) await finishBatchWallet(batch.id);
			})();
			return start;
		},

		/** Stop new work, then settle every dispatch and status read before storage closes. */
		close() {
			closed = true;
			shutdown.resolve();
			for (const cancel of timers.values()) cancel();
			timers.clear();
			return Promise.allSettled([...dispatches, ...inFlight.values()]);
		},

		list: async () => summarize(await store.snapshot()),
		async history() {
			const snapshot = await batches.history();
			const jobs = await summarize({ jobs: snapshot.attempts, slots: snapshot.slots });
			const groups = Map.groupBy(jobs, (job) => job.batchId);
			return {
				jobs: groups.get(null) ?? [],
				batches: snapshot.batches.map((batch) => batchHistory(batch, groups.get(batch.id) ?? [])),
			};
		},

		async refresh(id: string) {
			await readStatus(id, false, false, true);
		},

		needsCredential: (provider: ProviderId) => store.needsCredential(provider, now()),
	};
}
