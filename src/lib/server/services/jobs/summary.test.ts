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
	save_seconds: 15,
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
	file_phase: null,
	file_owner: null,
	file_references: null,
	file_stop: null,
	file_stop_slot: null,
	file_other_slot: null,
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
	contract: null,
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

const fileJob = (overrides: Partial<ImageJob>): ImageJob => ({
	...h3,
	id: "file",
	model: "seedream-5.5",
	operation: "reference-image-edit",
	state: "rejected",
	task_id: null,
	file_owner: "runtime",
	file_phase: "stored",
	file_references: 3,
	...overrides,
});

test("a file job reports each file slot, its stop and the hosted-copy warning", () => {
	const job = summarizeJob(
		fileJob({ file_stop: "duplicate", file_stop_slot: 1, file_other_slot: 2 }),
		false,
		now,
		null,
		[
			{ position: 1, outcome: "stored" },
			{ position: 3, outcome: "unsent" },
		],
	);
	expect(job.file).toEqual({
		references: 3,
		slots: [
			{ position: 1, outcome: "stored" },
			{ position: 3, outcome: "unsent" },
		],
		hosted: true,
	});
	expect(job.message).toBe(
		"The upload for reference 1 returned the same link as reference 2, so the edit was not sent.",
	);
	const unsent = summarizeJob(
		fileJob({ file_phase: "unsent", file_stop: "stage-changed", file_stop_slot: 1 }),
		false,
		now,
		null,
		[{ position: 1, outcome: "unsent" }],
	);
	expect(unsent.file?.hosted).toBeFalse();
	expect(unsent.message).toBe(
		"Reference 1 changed on this computer after Review, so nothing more was sent.",
	);
	const unknown = summarizeJob(
		fileJob({ file_phase: "upload-unknown", state: "unknown" }),
		false,
		now,
		null,
		[
			{ position: 1, outcome: "stored" },
			{ position: 2, outcome: "unknown" },
		],
	);
	expect(unknown.file?.hosted).toBeTrue();
});

test("a cooldown stop, including an R1b one, reports the next allowed time", () => {
	for (const phase of ["unsent", "stored"] as const) {
		const job = summarizeJob(
			fileJob({
				file_phase: phase,
				file_stop: "cooldown",
				file_stop_slot: phase === "unsent" ? 1 : null,
				retry_at: 5_000,
				file_references: 1,
			}),
			false,
			now,
			null,
			[{ position: 1, outcome: phase === "unsent" ? "unsent" : "stored" }],
		);
		expect(job.message).toBe(
			`Provider cooldown until ${new Date(5_000).toISOString()}. Review again before queuing.`,
		);
	}
	// A rejection's `retry_at` without a cooldown stop is no cooldown.
	expect(
		summarizeJob(fileJob({ retry_at: 5_000 }), false, now, null, [
			{ position: 1, outcome: "stored" },
		]).message ?? "",
	).not.toContain("cooldown");
});

test("interrupted and expired stops name their slot, or the edit", () => {
	const message = (overrides: Partial<ImageJob>) =>
		summarizeJob(fileJob(overrides), false, now, null, []).message;
	expect(message({ file_stop: "interrupted", file_stop_slot: 3 })).toBe(
		"Siluet stopped before reference 3 was sent.",
	);
	expect(message({ file_stop: "interrupted" })).toBe("Siluet stopped before the edit was sent.");
	expect(message({ file_stop: "expired-link", file_stop_slot: 2 })).toBe(
		"The hosted link for reference 2 expired before the edit was sent.",
	);
	expect(message({ file_stop: "unusable", file_stop_slot: 2 })).toBe(
		"The upload for reference 2 returned a link the edit cannot use.",
	);
	expect(message({ file_stop: "destination" })).toBe(
		"The provider address could not be verified, so the edit was not sent.",
	);
});

test("media input wording follows the job's operation", () => {
	const seedance = {
		...h3,
		provider: "toapis",
		model: "seedance-2-5",
		business_id: "siluet-1",
		task_id: null,
	} as const;
	const image = {
		...h3,
		provider: "toapis",
		model: "doubao-seedream-5-5",
		video_terms: null,
	} as const;
	const frame =
		"ToAPIs refused a frame before creating a task. Check that each URL is publicly reachable, points to a readable still image within 30 MB, and has no credentials.";
	const reference =
		"The provider refused a reference image before creating a task. Check that each URL is public and readable.";
	const generic = "The provider rejected the request's media input.";
	for (const [job, expected] of [
		[{ ...seedance, operation: "first-frame-to-video" }, frame],
		[{ ...seedance, operation: "first-and-last-frame-to-video" }, frame],
		[{ ...seedance, operation: "text-to-video" }, generic],
		[{ ...seedance, operation: null }, generic],
		[{ ...image, operation: "reference-image-edit" }, reference],
		[{ ...image, operation: null }, reference],
	] as const)
		expect(
			summarizeJob({ ...job, state: "rejected", rejection: "media-input" }, true, now).message,
		).toBe(expected);
});

test("an unreadable input on a failed task is worded by operation", () => {
	const failed = {
		...h3,
		provider: "toapis",
		model: "seedance-2-5",
		business_id: "siluet-1",
		state: "failed",
		failure_reason: "reference_media_unreadable",
	} as const;
	const image = { ...failed, model: "doubao-seedream-5-5", business_id: null, video_terms: null };
	for (const [job, expected] of [
		[
			{ ...failed, operation: "first-and-last-frame-to-video" },
			"The provider could not read a frame image.",
		],
		[{ ...failed, operation: "text-to-video" }, "The provider reported that the job failed."],
		[{ ...failed, operation: null }, "The provider reported that the job failed."],
		[
			{ ...image, operation: "reference-image-edit" },
			"The provider could not read one or more reference images.",
		],
		[{ ...image, operation: null }, "The provider could not read one or more reference images."],
		[
			{ ...failed, operation: "first-frame-to-video", failure_reason: null },
			"The provider reported that the job failed.",
		],
	] as const)
		expect(summarizeJob(job, true, now).message).toBe(expected);
});

test("a source-video edit names the source clip in every failure and refusal", () => {
	const edit = {
		...h3,
		provider: "toapis",
		model: "seedance-2-5",
		operation: "video-edit",
		business_id: "siluet-1",
	} as const;
	const checkSource = "Check the source clip against the limits shown at Review.";
	const failed = (change: Partial<ImageJob>, readable = true) =>
		summarizeJob({ ...edit, state: "failed", ...change }, readable, now).message;
	expect(
		summarizeJob({ ...edit, task_id: null, state: "rejected", rejection: "media-input" }, true, now)
			.message,
	).toBe(
		"ToAPIs refused the source clip before creating a task. Check that the URL is publicly reachable, points to a readable video within 100 MiB and has no credentials.",
	);
	expect(failed({ failure_reason: "reference_media_unreadable" })).toBe(
		"The provider could not read the source clip.",
	);
	expect(failed({ failure_reason: null })).toBe(
		`The provider reported that the job failed. ${checkSource}`,
	);
	// A later Refresh that cannot read status keeps the source guidance beside its note.
	expect(failed({ failure_reason: null, pause_reason: "temporary" })).toBe(
		`${checkSource} The provider status is temporarily unavailable.`,
	);
	expect(failed({ failure_reason: null }, false)).toBe(
		`${checkSource} Status and downloads of unsaved results require the original API key for this job.`,
	);
	// Other operations and legacy rows keep their wording.
	for (const operation of ["text-to-video", "first-frame-to-video", null] as const)
		expect(failed({ operation })).toBe("The provider reported that the job failed.");
	expect(
		summarizeJob({ ...edit, state: "rejected", rejection: "validation" }, true, now).message,
	).toBe("The provider rejected the request parameters.");
});

test("a valid edit outside the Gallery profile is held, not retryable, with billing kept", () => {
	const held = summarizeJob(
		{
			...h3,
			provider: "toapis",
			model: "seedance-2-5",
			operation: "video-edit",
			business_id: "siluet-1",
			save_hold: "unsupported",
			billing: JSON.stringify({ status: "settled", credits: "40", usd: "0.2" }),
		},
		true,
		now,
	);
	expect(held).toMatchObject({
		library: "unsupported",
		retryable: false,
		billing: { status: "settled", credits: "40", usd: "0.2" },
	});
});
