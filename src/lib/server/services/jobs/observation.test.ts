import { expect, test } from "bun:test";
import type { ImageJob } from "../../db/image-job-store";
import { statusUpdate } from "./observation";

const job = {
	id: "multi",
	provider: "poyo",
	state: "running",
	read_failures: 0,
	pause_reason: null,
	billing: null,
	expires_at: null,
	business_id: null,
	video_terms: null,
} as unknown as ImageJob;

test("a completed result with more than one image is held as unsupported, never retried", () => {
	const { update, resultUrl } = statusUpdate(
		job,
		{
			kind: "observed",
			state: "completed",
			failureReason: null,
			billing: null,
			resultUrl: null,
			multipleImageResult: true,
			expiresAt: null,
			retryAfter: null,
		},
		1_000,
		5_000,
	);
	expect(resultUrl).toBeNull();
	expect(update).toMatchObject({
		state: "completed",
		note: "multiple-image-result",
		saveHold: "unsupported",
	});
});

test("a completed result without a usable link stays a retryable failed download", () => {
	const { update } = statusUpdate(
		job,
		{
			kind: "observed",
			state: "completed",
			failureReason: null,
			billing: null,
			resultUrl: null,
			expiresAt: null,
			retryAfter: null,
		},
		1_000,
		5_000,
	);
	expect(update).toMatchObject({ note: "result-unavailable", saveHold: "failed" });
});
