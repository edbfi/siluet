import { sql } from "drizzle-orm";
import type { ProviderId } from "../../../shared/providers/connections";
import type { SeedanceBody } from "../../../shared/video-studio/seedance";
import { type BatchStop, imageBatchStore, retryStillSupported } from "../../db/image-batch-store";
import {
	hasCorrelation,
	type ImageJob,
	imageJobStore,
	isVideoJob,
	jobCredentialAccess,
	jobPollDeadline,
	skipImageSend,
} from "../../db/image-job-store";
import type { Installation } from "../../db/installation";
import { retryTime } from "../../db/provider-gate";
import type { providerStore } from "../../db/provider-store";
import type { CheckFetch } from "../../providers/connection-check";
import { type ReviewedImageRequest, statusTimeoutMs } from "../../providers/image-job";
import { createPoyoImage } from "../../providers/poyo/image";
import { createToapisImage } from "../../providers/toapis/image";
import { createToapisVideo } from "../../providers/toapis/video";
import { type BatchAuthorization, dispatchBatch } from "../queue/batch-dispatch";
import { createSubmitGate } from "../queue/submit-gate";
import type { VideoDelivery } from "../video-media/download";
import { batchHistory } from "./batch-history";
import { retryEvidence, statusUpdate } from "./observation";
import { isActive, isReadPaused, summarizeJob } from "./summary";

export type { JobSummary } from "./summary";

type JobCredentials = Pick<ReturnType<typeof providerStore>, "credential" | "jobReadability">;
type TrackingDependencies = {
	fetch?: CheckFetch;
	now?: () => number;
	random?: () => number;
	sleep?: (delay: number) => Promise<void>;
	scheduleRead?: typeof scheduleReadTimer;
};

function scheduleReadTimer(read: () => Promise<void>, delay: number) {
	const timer = setTimeout(() => void read(), delay).unref();
	return () => clearTimeout(timer);
}

const initialWait = { poyo: 2_000, toapis: 5_000 };
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
		sleep = (delay) => Bun.sleep(delay),
		scheduleRead = scheduleReadTimer,
	}: TrackingDependencies = {},
) {
	const store = imageJobStore(installation);
	const batches = imageBatchStore(installation);
	const gatedSend = createSubmitGate(installation, now, random);
	const video = createToapisVideo(read);
	const poyo = createPoyoImage(read);
	const adapters = { poyo, toapis: createToapisImage(read) };
	// Recovery may return a short-lived completed result before the next status read is allowed.
	// Keep its URL only in this runtime and require the durable observation to still match.
	const recoveredResults = new Map<
		string,
		{ token: string; until: number; delivery: VideoDelivery }
	>();
	function cachedResult(job: ImageJob) {
		const cached = recoveredResults.get(job.id);
		if (
			cached &&
			job.state === "completed" &&
			!job.pause_reason &&
			!job.read_token &&
			cached.token === job.video_observation_id &&
			now() < cached.until &&
			(job.expires_at === null || now() < job.expires_at)
		)
			return cached.delivery;
		recoveredResults.delete(job.id);
		return null;
	}
	const timers = new Map<string, () => void>();
	const inFlight = new Map<string, Promise<VideoDelivery | null>>();
	let start: Promise<void> | undefined;
	let closed = false;

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
				await readStatus(job.id, true).catch(() =>
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

	async function observe(id: string, automatic: boolean, lookup = false) {
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
		const observation =
			videoRead ?? (await adapters[job.provider].status(key, reserved.task_id ?? ""));
		const finished = now();
		const interval =
			initialWait[job.provider] + Math.floor(random() * (intervalJitter[job.provider] + 1));
		const { update, resultUrl } = statusUpdate(reserved, observation, finished, interval);
		const retry =
			automatic && reserved.retry_state
				? retryEvidence(reserved, observation, update.billing, finished, random)
				: null;
		const saved = await store.recordStatus(reserved, token, finished, {
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

		if (!saved) {
			if (lookup && videoRead?.taskId) await store.identityConflict(id, videoRead.taskId);
			return null;
		}
		if (isActive(reserved) && (saved.state === "completed" || saved.state === "failed"))
			await finishBalance(saved);
		const delivery = resultUrl ? { url: resultUrl, fallback: videoRead?.fallback ?? null } : null;
		if (lookup && delivery) {
			const until = Math.min(finished + interval, update.nextReadAt);
			recoveredResults.set(id, { token, until, delivery });
			setTimeout(
				() => {
					if (recoveredResults.get(id)?.token === token) recoveredResults.delete(id);
				},
				Math.max(0, until - now()),
			).unref();
		}
		return delivery;
	}

	function readStatus(id: string, automatic: boolean, lookup = false) {
		const active = inFlight.get(id);
		if (active) return active;
		const operation = observe(id, automatic, lookup)
			.then(async (url) => {
				const job = await store.get(id);
				if (job) schedule(job);
				return url;
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
					await sleep(Math.max(1, response.until - now()));
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

	async function summarize(rows: ImageJob[]) {
		const readable = rows.some((job) => job.task_id || hasCorrelation(job))
			? await credentials.jobReadability()
			: () => false;
		return rows.map((job) => ({
			hasRecoveredResult: !!cachedResult(job),
			...summarizeJob(job, readable(job), now()),
		}));
	}

	return {
		async dispatchVideo(id: string, key: string, body: SeedanceBody, business: string) {
			if (closed || !(await store.beginDispatch(id, "toapis", now()))) return;
			const response = await gatedSend(
				"toapis",
				Infinity,
				1,
				() => video.submit(key, body, business),
				{
					allowed: async (tx) =>
						!closed &&
						!!(await tx.get(
							sql`SELECT 1 FROM image_job j JOIN provider_credential c ON c.provider=j.provider AND c.revision=j.revision WHERE j.id=${id} AND j.state='submitting' AND c.ciphertext IS NOT NULL AND j.submission_recorded_at IS NULL`,
						)),
					blocked: (tx, reason, until) => skipImageSend(tx, id, reason, now(), until),
				},
			);
			if ("blocked" in response) return;
			const { result } = response;
			const job = await store.recordSubmission(id, result, now(), 5000, response.retryAt);
			if (job) schedule(job);
			else if (result.kind === "accepted") await store.identityConflict(id, result.taskId);
		},
		async lookup(id: string) {
			await readStatus(id, false, true);
		},
		async videoResult(id: string) {
			const job = await store.get(id);
			if (!job || !isVideoJob(job) || job.state !== "completed") return null;
			const delivery = cachedResult(job) ?? (await readStatus(id, false));
			return delivery && (await originalKey(job)) ? delivery : null;
		},
		async isVideo(id: string) {
			return isVideoJob(await store.get(id));
		},
		async dispatch(id: string, provider: ProviderId, key: string, request: ReviewedImageRequest) {
			if (closed || !(await store.beginDispatch(id, provider, now()))) return;
			await send(id, provider, key, request, 1, provider === "poyo");
		},
		async dispatchBatch(auth: BatchAuthorization) {
			let reason: BatchStop = "interrupted";
			try {
				reason = await dispatchBatch(
					auth,
					batches,
					(id, attempt, before) =>
						send(id, auth.provider, auth.key, auth.request, attempt, before, auth),
					now,
					sleep,
					() => closed,
				);
			} finally {
				if (!closed) {
					await batches.close(auth.id, reason, now());
					await finishBatchWallet(auth.id);
				}
			}
		},
		batches: batches.list,

		resume() {
			start ??= (async () => {
				await store.recover(now());
				for (const job of await store.list()) schedule(job);
				for (const batch of await batches.list()) await finishBatchWallet(batch.id);
			})();
			return start;
		},

		close() {
			closed = true;
			for (const cancel of timers.values()) cancel();
			timers.clear();
			recoveredResults.clear();
		},

		list: async () => summarize(await store.list()),
		async history() {
			const snapshot = await batches.history();
			const jobs = await summarize(snapshot.attempts);
			const groups = Map.groupBy(jobs, (job) => job.batchId);
			return {
				jobs: groups.get(null) ?? [],
				batches: snapshot.batches.map((batch) => batchHistory(batch, groups.get(batch.id) ?? [])),
			};
		},

		async refresh(id: string) {
			await readStatus(id, false);
		},

		async resultUrl(id: string) {
			const job = await store.get(id);
			if (job?.state !== "completed") return null;
			const url = await readStatus(id, false);
			// A Settings change during the read also stops delivery of an unsaved result.
			return url && !isVideoJob(job) && (await credentials.jobReadability())(job) ? url.url : null;
		},

		needsCredential: store.needsCredential,
	};
}
