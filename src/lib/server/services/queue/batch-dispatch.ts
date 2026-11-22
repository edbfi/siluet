import type { BatchStop, ImageBatch, imageBatchStore } from "../../db/image-batch-store";
import type { ImageJob } from "../../db/image-job-store";
import type { ReviewedImageRequest } from "../../providers/image-job";

export type BatchAuthorization = {
	id: string;
	deadline: number;
	count: number;
	retryLimit: number;
	key: string;
	provider: ImageBatch["provider"];
	request: ReviewedImageRequest;
	// Read local evidence before the transaction, then evaluate expiry and terms
	// again with the reservation clock while the credential revision is locked.
	checkTerms: () => Promise<() => boolean>;
};

function nextSlot(jobs: ImageJob[], count: number, retries: number, now: number) {
	const latest = new Map(jobs.map((job) => [job.slot, job]));
	for (let slot = 1; slot <= count; slot++) if (!latest.has(slot)) return { slot };
	let wait = Infinity;
	for (let slot = 1; slot <= count; slot++) {
		const job = latest.get(slot);
		if (!job?.attempt || job.attempt > retries) continue;
		if (job.retry_state === "ready") {
			const due = job.retry_at ?? 0;
			if (due <= now) return { slot };
			wait = Math.min(wait, due);
		} else if (
			(job.retry_state === "watch" || job.retry_state === "settlement") &&
			job.pause_reason !== "credential-changed"
		) {
			wait = Math.min(wait, now + 500);
		}
	}
	return { wait };
}

export async function dispatchBatch(
	auth: BatchAuthorization,
	store: ReturnType<typeof imageBatchStore>,
	send: (id: string, attempt: number, before: boolean) => Promise<BatchStop | undefined>,
	now: () => number,
	sleep: (delay: number) => Promise<void>,
	closed: () => boolean,
) {
	while (!closed() && now() < auth.deadline) {
		const next = nextSlot(await store.attempts(auth.id), auth.count, auth.retryLimit, now());
		if (next.slot !== undefined) {
			const check = await auth.checkTerms();
			const reserved = await store.reserve(auth.id, next.slot, now, check);
			if (reserved.stop) return reserved.stop;
			if (reserved.jobId) {
				const stop = await send(reserved.jobId, reserved.attempt, reserved.wallet);
				if (stop) return stop;
				continue;
			}
			if (reserved.wait) await sleep(Math.max(1, Math.min(auth.deadline, reserved.wait) - now()));
		} else {
			if (!Number.isFinite(next.wait)) return "finished";
			await sleep(Math.max(1, Math.min(auth.deadline, next.wait) - now()));
		}
	}
	return closed() ? "interrupted" : "expired";
}
