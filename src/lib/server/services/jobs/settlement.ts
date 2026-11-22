import { sumAmounts } from "../../../shared/pricing/decimal";
import type { TaskBilling } from "../../providers/image-job";
import type { JobSummary } from "./summary";

function completeAmount(billing: TaskBilling | null) {
	if (
		(billing?.status !== "settled" && billing?.status !== "refunded") ||
		billing.credits === null ||
		billing.usd === null
	)
		return null;
	const credits = sumAmounts([billing.credits]);
	const usd = sumAmounts([billing.usd]);
	if (billing.status === "refunded" && (credits !== "0" || usd !== "0")) return null;
	return { status: billing.status, credits, usd };
}

export function mergeBilling(
	last: TaskBilling | null,
	current: TaskBilling | null,
): TaskBilling | null {
	if (!current || current.status === "unknown") return last ?? current;
	if (last?.status === "conflicting") return last;
	const a = completeAmount(last);
	const b = completeAmount(current);
	if (a && b && (a.status !== b.status || a.credits !== b.credits || a.usd !== b.usd))
		return { status: "conflicting" };
	return current;
}

export function taskSettlement(
	jobs: Pick<JobSummary, "skipped" | "taskId" | "billing">[],
	closed: boolean,
) {
	const tasks = new Map<string, TaskBilling | null>();
	let complete = closed;
	for (const job of jobs) {
		if (job.skipped) continue;
		if (!job.taskId) {
			complete = false;
			continue;
		}
		tasks.set(job.taskId, mergeBilling(tasks.get(job.taskId) ?? null, job.billing));
	}
	const amounts = [...tasks.values()].map(completeAmount).filter((amount) => amount !== null);
	return {
		complete: complete && amounts.length === tasks.size,
		credits: sumAmounts(amounts.map((a) => a.credits)),
		usd: sumAmounts(amounts.map((a) => a.usd)),
	};
}
