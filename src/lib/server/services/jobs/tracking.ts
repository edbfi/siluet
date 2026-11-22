import type { ProviderId } from "../../../shared/providers/connections";
import { imageCredentialAccess } from "../../db/image-credential-access";
import { type ImageJob, imageJobStore, type StatusNote } from "../../db/image-job-store";
import type { Installation } from "../../db/installation";
import type { providerStore } from "../../db/provider-store";
import type { CheckFetch } from "../../providers/connection-check";
import {
	type ReviewedImageRequest,
	statusTimeoutMs,
	type TaskBilling,
	type TaskFailureReason,
	type TaskObservation,
} from "../../providers/image-job";
import { createPoyoImage } from "../../providers/poyo/image";
import { createToapisImage } from "../../providers/toapis/image";
import { isActive, isReadPaused, storedBilling, summarizeJob } from "./summary";

export type { JobSummary } from "./summary";

type JobCredentials = Pick<ReturnType<typeof providerStore>, "credential" | "jobReadability">;
type TrackingDependencies = { fetch?: CheckFetch; now?: () => number; random?: () => number };

const initialWait = { poyo: 2_000, toapis: 5_000 };
const intervalJitter = { poyo: 3_000, toapis: 5_000 };

function retryTime(value: string | null, now: number) {
	if (!value) return now;
	if (/^\d+$/.test(value)) return Math.min(8.64e15, now + 1_000 * Number(value));
	const absolute = Date.parse(value);
	return Number.isFinite(absolute) ? Math.max(now, absolute) : now;
}

function mergeBilling(last: TaskBilling | null, current: TaskBilling | null) {
	if (!current || current.status === "unknown") return last ?? current;
	if (
		(current.status === "settled" || current.status === "refunded") &&
		last?.status === current.status
	) {
		return {
			status: current.status,
			credits: current.credits ?? last.credits,
			usd: current.usd ?? last.usd,
		};
	}
	return current;
}

function statusUpdate(job: ImageJob, observation: TaskObservation, now: number, interval: number) {
	const failures = observation.kind === "temporary" ? Math.min(job.read_failures + 1, 8) : 0;
	const delay = Math.min(60_000, interval * 2 ** failures);
	let note: StatusNote | null = null;
	let state = job.state;
	let failureReason: TaskFailureReason | null = null;
	let billing = storedBilling(job);
	let expiresAt = job.expires_at;
	let resultUrl: string | null = null;

	if (observation.kind === "paused") note = observation.reason;
	if (observation.kind === "temporary")
		note = isReadPaused(job.pause_reason) ? job.pause_reason : "temporary";
	if (observation.kind === "observed") {
		if (isActive(job) || job.state === observation.state) {
			state = observation.state;
			failureReason = observation.failureReason;
			billing = mergeBilling(billing, observation.billing);
			expiresAt = observation.expiresAt ?? job.expires_at;
			if (state === "completed") {
				resultUrl = expiresAt !== null && expiresAt <= now ? null : observation.resultUrl;
				if (!resultUrl) note = "result-unavailable";
			}
		} else {
			note = "unknown-status";
		}
	}

	return {
		update: {
			state,
			billing,
			expiresAt,
			note,
			failureReason,
			failures,
			nextReadAt:
				observation.kind !== "observed"
					? Math.max(now + delay, retryTime(observation.retryAfter, now))
					: now + delay,
		},
		resultUrl,
	};
}

export function createJobTracking(
	installation: Installation,
	credentials: JobCredentials,
	{ fetch: read, now = Date.now, random = Math.random }: TrackingDependencies = {},
) {
	const store = imageJobStore(installation);
	const poyo = createPoyoImage(read);
	const adapters = { poyo, toapis: createToapisImage(read) };
	const timers = new Map<string, ReturnType<typeof setTimeout>>();
	const inFlight = new Map<string, Promise<string | null>>();
	let start: Promise<void> | undefined;
	let closed = false;

	function cancelTimer(id: string) {
		clearTimeout(timers.get(id));
		timers.delete(id);
	}

	function schedule(job: ImageJob, earliest = 0) {
		cancelTimer(job.id);
		if (closed || !isActive(job) || isReadPaused(job.pause_reason) || job.next_read_at === null)
			return;
		const due = Math.max(job.next_read_at, earliest);
		if (due >= job.poll_deadline || now() >= job.poll_deadline) return;
		const timer = setTimeout(
			() => {
				timers.delete(job.id);
				void readStatus(job.id, true).catch(() => schedule(job, now() + initialWait[job.provider]));
			},
			Math.max(0, due - now()),
		);
		timers.set(job.id, timer.unref());
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
		if (
			automatic &&
			(!isActive(job) || now() >= job.poll_deadline || isReadPaused(job.pause_reason))
		)
			return null;

		const key = await originalKey(job);
		if (closed) return null;
		if (!key) {
			await store.recordMissingCredential(id);
			return null;
		}

		const started = now();
		const token = crypto.randomUUID();
		// The durable reservation covers a read interrupted by a restart before its cooldown is known.
		const holdUntil =
			started + statusTimeoutMs + initialWait[job.provider] + intervalJitter[job.provider];
		const reserved = await store.reserveRead(id, token, started, holdUntil, automatic);
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
		const saved = await store.recordStatus(id, token, finished, update);
		if (!saved) return null;
		if (isActive(reserved) && (saved.state === "completed" || saved.state === "failed"))
			await afterBalance(saved);
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

	return {
		async dispatch(id: string, provider: ProviderId, key: string, request: ReviewedImageRequest) {
			if (closed) return;
			if (!(await store.beginDispatch(id, provider, now()))) return;
			if (provider === "poyo") {
				const before = await poyo.balance(key);
				await store.recordBefore(id, before, now());
			}
			if (closed) return;
			const result = await adapters[provider].submit(key, request);
			const job = await store.recordSubmission(id, result, now(), initialWait[provider]);
			if (!job) return;
			if (job.state === "rejected") await afterBalance(job);
			schedule(job);
		},

		resume() {
			start ??= (async () => {
				await store.recover(now());
				for (const job of await store.list()) schedule(job);
			})();
			return start;
		},

		close() {
			closed = true;
			for (const timer of timers.values()) clearTimeout(timer);
			timers.clear();
		},

		async list() {
			const rows = await store.list();
			const readable = rows.some((job) => job.task_id)
				? await credentials.jobReadability()
				: () => false;
			return rows.map((job) => summarizeJob(job, readable(job), now()));
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
