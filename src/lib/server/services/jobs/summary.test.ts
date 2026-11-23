import { expect, test } from "bun:test";
import type { ImageJob } from "../../db/image-job-store";
import { summarizeJob } from "./summary";

const now = 1_000_000;
const h3: ImageJob = {
	id: "h3",
	provider: "poyo",
	revision: 1,
	model: "h3-max",
	operation: "text-to-video",
	quote: JSON.stringify({ status: "unknown", reason: "missing-feed", maxAttempts: 1 }),
	state: "completed",
	created_at: 0,
	updated_at: 10,
	poll_deadline: 120_000,
	submission_recorded_at: 5,
	task_id: "h3_task",
	business_id: null,
	video_terms: "[]",
	video_poll_deadline: null,
	video_progress: null,
	video_observation_id: null,
	read_token: null,
	next_read_at: null,
	read_failures: 0,
	pause_reason: null,
	rejection: null,
	failure_reason: null,
	billing: null,
	expires_at: null,
	save_due: null,
	save_hold: null,
	save_attempt: null,
	save_tries: 0,
	batch_id: null,
	transient_failure: null,
	slot: null,
	attempt: null,
	completion_seen: 1,
	retry_state: null,
	retry_at: null,
	skipped: null,
	throttle: 0,
	wallet_open: 0,
	wallet_overlap: 0,
	wallet_finish_by: null,
	wallet_before: null,
	wallet_before_at: null,
	wallet_after: null,
	wallet_after_at: null,
};

test("permission rejection message", () => {
	const job = { ...h3, state: "rejected", task_id: null, rejection: "permission" } as const;
	expect(summarizeJob(job, true, now)).toMatchObject({
		state: "rejected",
		video: true,
		message: "Poyo.ai refused this model for this key. The saved key is unchanged.",
	});
	expect(summarizeJob({ ...job, rejection: "authorization" }, true, now).message).toBe(
		"The provider rejected the API key or its permissions.",
	);
	expect(
		summarizeJob(
			{ ...job, provider: "toapis", business_id: "siluet-1", rejection: "authorization" },
			true,
			now,
		).message,
	).toBe("ToAPIs denied this submission.");
});

test("an unsent video job reports when the next submission is available", () => {
	const unsent = {
		...h3,
		state: "rejected",
		task_id: null,
		skipped: "cooldown",
		retry_at: now + 60_000,
	} as const;
	expect(summarizeJob(unsent, true, now)).toMatchObject({
		state: "unsent",
		video: true,
		submitAfter: now + 60_000,
		wallet: null,
	});
	expect(summarizeJob({ ...unsent, skipped: "interrupted" }, true, now).submitAfter).toBeNull();
	expect(summarizeJob(unsent, true, now).message).toBe(
		"Not submitted. A provider cooldown was active. Review again before queuing.",
	);
	expect(summarizeJob(unsent, true, now + 60_000).submitAfter).toBeNull();
});

test("a throttled video job reports its cooldown and stays uncertain", () => {
	const throttled = {
		...h3,
		state: "unknown",
		task_id: null,
		throttle: 1,
		retry_at: now + 60_000,
	} as const;
	expect(summarizeJob(throttled, true, now)).toMatchObject({
		state: "unknown",
		submitAfter: now + 60_000,
		message: expect.stringContaining("Check provider history"),
	});
	expect(summarizeJob(throttled, true, now + 60_000).submitAfter).toBeNull();
});

test("every video job uses the video window, retry gate and expiry wording", () => {
	expect(summarizeJob({ ...h3, state: "running" }, true, 300_000)).toMatchObject({
		tracking: "automatic",
		pollDeadline: 600_005,
	});
	expect(summarizeJob({ ...h3, state: "running" }, true, 600_005).tracking).toBe("manual");
	const failed = { ...h3, save_hold: "failed" } as const;
	expect(summarizeJob(failed, true, now)).toMatchObject({ retryable: true, video: true });
	expect(summarizeJob({ ...failed, pause_reason: "authorization" }, true, now).retryable).toBe(
		false,
	);
	const expired = { ...failed, expires_at: now - 1 };
	expect(summarizeJob(expired, true, now)).toMatchObject({
		retryable: false,
		message: "The provider's last reported video expiry has passed.",
	});
	expect(summarizeJob({ ...h3, pause_reason: "result-unavailable" }, true, now).message).toBe(
		"No usable video result was available. Check provider history or Retry download.",
	);
	expect(summarizeJob({ ...h3, model: "seedream-5.5", video_terms: null }, true, now).video).toBe(
		false,
	);
});

test("library shows one Save state in precedence order with a separate retry flag", () => {
	const pending = { ...h3, save_due: now };
	type Case = [string, Partial<ImageJob>, Gallery, boolean, string, boolean];
	type Gallery = "saved" | "unavailable" | null;
	const cases: Case[] = [
		["saved beats a stale hold", { save_hold: "failed" }, "saved", true, "saved", false],
		["unavailable", {}, "unavailable", true, "unavailable", true],
		["unavailable after expiry", { expires_at: now }, "unavailable", true, "unavailable", false],
		["removed", { save_hold: "removed" }, null, true, "removed", true],
		["unsupported", { save_hold: "unsupported" }, null, true, "unsupported", false],
		["webm", { save_hold: "webm" }, null, true, "webm", false],
		["failed", { save_hold: "failed" }, null, true, "failed", true],
		["failed without the key", { save_hold: "failed" }, null, false, "failed", false],
		[
			"failed while paused",
			{ save_hold: "failed", pause_reason: "missing-task" },
			null,
			true,
			"failed",
			false,
		],
		[
			"failed while saving",
			{ save_hold: "failed", save_attempt: "a" },
			null,
			true,
			"failed",
			false,
		],
		["expired", { ...pending, expires_at: now }, null, false, "expired", false],
		["needs key", pending, null, false, "needs-key", false],
		["paused", { ...pending, pause_reason: "unknown-status" }, null, true, "paused", false],
		["saving", { ...pending, save_attempt: "a" }, null, true, "saving", false],
		["waiting", pending, null, true, "waiting", false],
		[
			"waiting after a link-less read",
			{ ...pending, pause_reason: "result-unavailable" },
			null,
			true,
			"waiting",
			false,
		],
		["none after expiry was cleared", {}, null, true, "none", false],
		["none before completion", { state: "running" }, null, true, "none", false],
	];
	for (const [name, change, gallery, readable, library, retryable] of cases) {
		expect(summarizeJob({ ...h3, ...change }, readable, now, gallery), name).toMatchObject({
			library,
			retryable,
		});
		// Batch attempts use the same projection.
		expect(
			summarizeJob(
				{ ...h3, ...change, batch_id: "batch", slot: 1, attempt: 1 },
				readable,
				now,
				gallery,
			),
			name,
		).toMatchObject({ library, retryable });
	}
});
