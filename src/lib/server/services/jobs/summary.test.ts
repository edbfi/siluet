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
	gallery_reason: null,
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

test("every video job uses the video window, Save gate and expiry wording", () => {
	expect(summarizeJob({ ...h3, state: "running" }, true, 300_000)).toMatchObject({
		tracking: "automatic",
		pollDeadline: 600_005,
	});
	expect(summarizeJob({ ...h3, state: "running" }, true, 600_005).tracking).toBe("manual");
	expect(summarizeJob(h3, true, now)).toMatchObject({ canSave: true, video: true });
	expect(summarizeJob({ ...h3, pause_reason: "authorization" }, true, now).canSave).toBe(false);
	const expired = { ...h3, expires_at: now - 1 };
	expect(summarizeJob(expired, true, now)).toMatchObject({
		canSave: false,
		message: "The provider's last reported video expiry has passed.",
	});
	expect(summarizeJob({ ...h3, pause_reason: "result-unavailable" }, true, now).message).toBe(
		"No usable video result was available. Check provider history or retry Save.",
	);
	expect(summarizeJob({ ...h3, model: "seedream-5.5", video_terms: null }, true, now).video).toBe(
		false,
	);
});
