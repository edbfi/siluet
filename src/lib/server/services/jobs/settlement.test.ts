import { expect, test } from "bun:test";
import type { TaskBilling } from "../../providers/image-job";
import { mergeBilling, taskSettlement } from "./settlement";

test("one coherent observation proves each distinct charge and an unaccounted POST keeps the total unknown", () => {
	const task = (taskId: string | null, billing: TaskBilling | null) => ({
		taskId,
		billing,
		skipped: null,
	});
	const settled = task("a", {
		status: "settled",
		usd: "0.0000000000000000001",
		credits: "50.07500000001",
	});
	const refund = task("b", { status: "refunded", usd: "0", credits: "0.0000" });
	const jobs = [
		settled,
		refund,
		settled,
		task("c", { status: "settled", credits: "4.005", usd: "0.4" }),
	];
	expect(taskSettlement(jobs, true)).toEqual({
		complete: true,
		credits: "54.08000000001",
		usd: "0.4000000000000000001",
	});
	expect(taskSettlement([...jobs, task(null, null)], true).complete).toBe(false);
	expect(
		taskSettlement([...jobs, { ...task(null, null), skipped: "expired" }], true).complete,
	).toBe(true);
	expect(
		taskSettlement(
			[...jobs, task("a", { status: "settled", credits: "2", usd: "1" }), settled],
			true,
		),
	).toEqual({ complete: false, credits: "4.005", usd: "0.4" });
	const partial = mergeBilling(
		{ status: "settled", credits: "1", usd: null },
		{ status: "settled", credits: null, usd: "0" },
	);
	expect(taskSettlement([task("partial", partial)], true).complete).toBe(false);
});
