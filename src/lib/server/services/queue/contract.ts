// The recoverable contract a claimed Poyo.ai image job stores (catalog engine spec, "Claims and
// replay"): enough to dispatch, recover and save from storage after a re-pin removes its row.
import { expectedImageType } from "../../../shared/media-catalog/formats";
import { queueRevision } from "../../../shared/media-catalog/image-queue";

/** The Poyo.ai image adapter this build reads: its submit, status route and result envelope. */
export const poyoImageAdapter = "poyo-image-v1";

type OperationKey = {
	readonly provider: string;
	readonly model: string;
	readonly route: string;
	readonly operation: string;
};

/**
 * The contract JSON for one claim. A shipped operation has no projection row, so its row digest
 * is null; a derived row binds its queue row's contract digest.
 */
export function imageJobContract(
	operationKey: OperationKey,
	rowDigest: string | null,
	sentFormat: string | undefined,
) {
	return JSON.stringify({
		v: 1,
		operationKey,
		revision: queueRevision,
		rowDigest,
		adapter: poyoImageAdapter,
		statusRoute: "GET /api/generate/status/{task_id}",
		result: { envelope: poyoImageAdapter, responseModel: "none" },
		formats: { sent: sentFormat ?? null, expected: expectedImageType(sentFormat)?.type ?? null },
	});
}

/**
 * How a stored contract is read: NULL keeps the shipped adapter paths, the current version
 * reads Poyo.ai's status route, and any other version is held unread.
 */
export function contractReader(contract: string | null): "shipped" | "current" | "held" {
	if (contract === null) return "shipped";
	try {
		const parsed = JSON.parse(contract) as { v?: unknown; adapter?: unknown };
		return parsed.v === 1 && parsed.adapter === poyoImageAdapter ? "current" : "held";
	} catch {
		return "held";
	}
}
