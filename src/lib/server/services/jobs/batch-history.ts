import type { PriceEstimate } from "../../../shared/pricing/estimate";
import type { ImageBatch } from "../../db/image-batch-store";
import { taskSettlement } from "./settlement";
import type { JobSummary } from "./summary";

function outcome(
	attempts: JobSummary[],
	closed: boolean,
): "unsent" | "pending" | "uncertain" | "successful" | "paused" | "failed" | "rejected" {
	const last = attempts.at(-1);
	if (!last) return closed ? "unsent" : "pending";
	if (attempts.some((attempt) => attempt.state === "completed")) return "successful";
	if (last.skipped && attempts.length === 1) return "unsent";
	if (last.state === "unknown") return "uncertain";
	if (last.tracking === "paused" && last.state !== "failed") return "paused";
	if (["waiting", "running", "submitting"].includes(last.state)) return "pending";
	if (attempts.some((attempt) => attempt.taskId)) return "failed";
	return "rejected";
}

export function batchHistory(batch: ImageBatch, jobs: JobSummary[]) {
	const attempts = jobs
		.filter((job) => job.batchId === batch.id)
		.sort((a, b) => (a.attempt ?? 0) - (b.attempt ?? 0));
	const closed = batch.closed_reason !== null;
	const requests = Array.from({ length: batch.request_count }, (_, i) => {
		const rows = attempts.filter((job) => job.slot === i + 1);
		return {
			slot: i + 1,
			attempts: rows,
			used: rows.filter((job) => !job.skipped).length,
			outcome: outcome(rows, closed),
		} as const;
	});
	const counts = {
		successful: 0,
		failed: 0,
		rejected: 0,
		uncertain: 0,
		unsent: 0,
		pending: 0,
		paused: 0,
	};
	for (const request of requests) counts[request.outcome]++;
	return {
		id: batch.id,
		provider: batch.provider,
		deadline: batch.deadline,
		reason: batch.closed_reason,
		retryLimit: batch.retry_limit,
		requests,
		counts,
		quote: JSON.parse(batch.quote) as PriceEstimate,
		wallet:
			batch.provider === "poyo" && counts.uncertain > 0
				? ({ status: "unavailable", reason: "uncertain" } as const)
				: (attempts.find((job) => job.wallet)?.wallet ?? null),
		settlement: batch.provider === "toapis" ? taskSettlement(attempts, closed) : null,
	};
}
