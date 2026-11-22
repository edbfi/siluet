import { sql } from "drizzle-orm";
import type { ProviderId } from "../../../shared/providers/connections";
import { type BatchStop, imageBatchStore, retryStillSupported } from "../../db/image-batch-store";
import { imageCredentialAccess } from "../../db/image-credential-access";
import { type ImageJob, imageJobStore, skipImageSend } from "../../db/image-job-store";
import type { Installation } from "../../db/installation";
import { retryTime } from "../../db/provider-gate";
import type { providerStore } from "../../db/provider-store";
import type { CheckFetch } from "../../providers/connection-check";
import { type ReviewedImageRequest, statusTimeoutMs } from "../../providers/image-job";
import { createPoyoImage } from "../../providers/poyo/image";
import { createToapisImage } from "../../providers/toapis/image";
import { type BatchAuthorization, dispatchBatch } from "../queue/batch-dispatch";
import { createSubmitGate } from "../queue/submit-gate";
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
	const poyo = createPoyoImage(read);
	const adapters = { poyo, toapis: createToapisImage(read) };
	const timers = new Map<string, () => void>();
	const inFlight = new Map<string, Promise<string | null>>();
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
		if (due >= job.poll_deadline || now() >= job.poll_deadline) return;
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
		return (
			await credentials.credential(
				job.provider,
				job.revision,
				imageCredentialAccess(job.provider, job.model),
			)
		)?.key;
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

	async function observe(id: string, automatic: boolean) {
		const job = await store.get(id);
		if (closed || !job?.task_id || job.next_read_at === null || job.next_read_at > now())
			return null;
		if (automatic && (!autoTrack(job) || now() >= job.poll_deadline)) return null;

		const key = await originalKey(job);
		if (closed) return null;
		if (!key) {
			await store.recordMissingCredential(id);
			return null;
		}

		const token = crypto.randomUUID();
		// The durable reservation covers a read interrupted by a restart before its cooldown is known.
		const holdMs = statusTimeoutMs + initialWait[job.provider] + intervalJitter[job.provider];
		const reserved = await store.reserveRead(id, token, now, holdMs, automatic);
		if (closed || !reserved?.task_id) return null;
		if (automatic && now() >= reserved.poll_deadline) {
			await store.releaseUnread(id, token, job.next_read_at);
			return null;
		}

		const observation = await adapters[job.provider].status(key, reserved.task_id);
		const finished = now();
		const interval =
			initialWait[job.provider] + Math.floor(random() * (intervalJitter[job.provider] + 1));
		const { update, resultUrl } = statusUpdate(reserved, observation, finished, interval);
		const retry =
			automatic && reserved.retry_state
				? retryEvidence(reserved, observation, update.billing, finished, random)
				: null;
		const saved = await store.recordStatus(id, token, finished, {
			...update,
			retry,
			queryAfter: Math.max(
				observation.queryAfter ?? 0,
				observation.kind === "temporary" ? retryTime(observation.retryAfter, finished) : 0,
			),
		});

		if (!saved) return null;
		if (isActive(reserved) && (saved.state === "completed" || saved.state === "failed"))
			await finishBalance(saved);
		return resultUrl;
	}

	function readStatus(id: string, automatic: boolean) {
		const active = inFlight.get(id);
		if (active) return active;
		const operation = observe(id, automatic)
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
		const readable = rows.some((job) => job.task_id)
			? await credentials.jobReadability()
			: () => false;
		return rows.map((job) => summarizeJob(job, readable(job), now()));
	}

	return {
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
			return url && (await credentials.jobReadability())(job) ? url : null;
		},

		needsCredential: store.needsCredential,
	};
}
