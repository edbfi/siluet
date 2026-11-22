import { sql } from "drizzle-orm";
import { type SeedreamOperation, seedreamOperation } from "../../shared/media-catalog/registry";
import type { ProviderId } from "../../shared/providers/connections";
import { imageJobPollingWindowMs } from "./image-job-schema";
import type { ImageJob } from "./image-job-store";
import type { Installation, InstallationTransaction } from "./installation";
import { nextProviderStart } from "./provider-gate";

function retryContradicted(previous: ImageJob) {
	return (
		previous.completion_seen === 1 ||
		(previous.billing !== null && JSON.parse(previous.billing).status === "conflicting")
	);
}

export async function retryStillSupported(tx: InstallationTransaction, id: string) {
	const previous = await tx.all<ImageJob>(sql`SELECT previous.* FROM image_job retry
		JOIN image_job previous ON previous.batch_id=retry.batch_id AND previous.slot=retry.slot
			AND previous.attempt<retry.attempt
		WHERE retry.id=${id}`);
	return previous.length > 0 && !previous.some(retryContradicted);
}

export type BatchStop = "finished" | "expired" | "terms" | "rejection" | "interrupted" | "cooldown";
export type ImageBatch = {
	id: string;
	provider: ProviderId;
	revision: number;
	request_count: number;
	retry_limit: number;
	quote: string;
	created_at: number;
	deadline: number;
	closed_reason: BatchStop | null;
	model: string;
	operation: SeedreamOperation;
	accepted_unknown: number;
};

export async function markWalletOverlap(tx: InstallationTransaction, now: number) {
	const open = sql`wallet_open=1 AND (wallet_finish_by IS NULL OR wallet_finish_by>${now})`;
	await tx.run(sql`UPDATE image_job SET wallet_overlap=1 WHERE ${open}
		AND (SELECT count(*) FROM image_job WHERE ${open})>1`);
}

export function imageBatchStore({ use }: Installation) {
	return {
		list: () =>
			use((db) => db.all<ImageBatch>(sql`SELECT * FROM image_batch ORDER BY created_at DESC`)),
		history: () =>
			use((db) =>
				db.transaction(async (tx) => ({
					batches: await tx.all<ImageBatch>(
						sql`SELECT * FROM image_batch ORDER BY created_at DESC`,
					),
					attempts: await tx.all<ImageJob>(
						sql`SELECT * FROM image_job ORDER BY created_at DESC,id`,
					),
				})),
			),

		attempts: (id: string) =>
			use((db) =>
				db.all<ImageJob>(sql`SELECT * FROM image_job WHERE batch_id=${id} ORDER BY slot,attempt`),
			),
		close: (id: string, reason: BatchStop, now: number) =>
			use((db) =>
				db.transaction(
					async (tx) => {
						await tx.run(
							sql`UPDATE image_batch SET closed_reason=${reason},closed_at=${now} WHERE id=${id} AND closed_reason IS NULL`,
						);
						await tx.run(sql`UPDATE image_job SET retry_state=NULL WHERE batch_id=${id}`);
					},
					{ behavior: "immediate" },
				),
			),
		// The first attempt owns the batch's single wallet interval, even when that task
		// finishes while a sibling is in flight or still waiting for retry consent to expire.
		claimAfter: (id: string, now: number) =>
			use((db) =>
				db.get<ImageJob>(sql`UPDATE image_job SET wallet_finish_by=MIN(${now},MAX(
				(SELECT closed_at FROM image_batch WHERE id=${id}),(SELECT MAX(updated_at) FROM image_job WHERE batch_id=${id})))+10000
			WHERE batch_id=${id} AND wallet_open=1 AND wallet_finish_by IS NULL
			AND EXISTS (SELECT 1 FROM image_batch WHERE id=${id} AND closed_reason IS NOT NULL)
			AND NOT EXISTS (SELECT 1 FROM image_job WHERE batch_id=${id} AND state IN ('submitting','unknown','running','waiting'))
			RETURNING *`),
			),
		reserve(id: string, slot: number, now: () => number, termsCurrent: () => boolean) {
			return use((db) =>
				db.transaction(
					async (tx) => {
						const batch = await tx.get<ImageBatch>(
							sql`SELECT * FROM image_batch WHERE id=${id} AND closed_reason IS NULL`,
						);
						if (!batch) return { stop: "interrupted" } as const;
						const time = now();
						if (time >= batch.deadline) return { stop: "expired" } as const;
						const credential =
							await tx.get(sql`SELECT 1 FROM provider_credential WHERE provider=${batch.provider}
					AND revision=${batch.revision} AND ciphertext IS NOT NULL AND seedream=1`);
						if (!credential || !termsCurrent()) return { stop: "terms" } as const;
						const until = await nextProviderStart(tx, batch.provider, "submit", time);
						if (until >= batch.deadline) return { stop: "cooldown" } as const;
						if (until > time) return { wait: until } as const;
						const previous = await tx.all<ImageJob>(
							sql`SELECT * FROM image_job WHERE batch_id=${id} AND slot=${slot} ORDER BY attempt DESC`,
						);
						const [last] = previous;
						const attempt = (last?.attempt ?? 0) + 1;
						if (
							slot < 1 ||
							slot > batch.request_count ||
							attempt > batch.retry_limit + 1 ||
							(last && (last.retry_state !== "ready" || (last.retry_at ?? 0) > time))
						)
							return { stop: "interrupted" } as const;
						// A Refresh can reveal a conflicting charge during automatic retry backoff.
						if (last && previous.some(retryContradicted)) {
							await tx.run(
								sql`UPDATE image_job SET retry_state='done',retry_at=NULL WHERE id=${last.id}`,
							);
							return {};
						}
						const operation = seedreamOperation(batch.provider, batch.operation)?.key;
						if (!operation || operation.model !== batch.model) return { stop: "terms" } as const;
						const jobId = crypto.randomUUID();
						const wallet = batch.provider === "poyo" && slot === 1 && attempt === 1;
						const watch = batch.provider === "toapis" && attempt <= batch.retry_limit;
						await tx.run(sql`INSERT INTO image_job(id,binding,provider,revision,quote,accepted_unknown,state,model,operation,created_at,poll_deadline,
					dispatch_started_at,batch_id,slot,attempt,wallet_open,retry_state)
					VALUES(${jobId},'',${batch.provider},${batch.revision},${batch.quote},${batch.accepted_unknown},'submitting',${batch.model},${operation.operation},${time},
					${time + imageJobPollingWindowMs},${time},${id},${slot},${attempt},${Number(wallet)},${watch ? "watch" : null})`);
						if (wallet) await markWalletOverlap(tx, time);
						return { jobId, wallet, attempt } as const;
					},
					{ behavior: "immediate" },
				),
			);
		},
	};
}
