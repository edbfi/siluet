import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { Glob } from "bun";
import {
	hasCorrelation,
	isVideoJob,
	jobCredentialAccess,
	jobPollDeadline,
} from "./image-job-store";
import { videoJobPollingWindowMs } from "./video-schema";

const image = {
	provider: "poyo",
	revision: 1,
	model: "seedream-5.5",
	business_id: null,
	video_terms: null,
	video_poll_deadline: null,
	poll_deadline: 120_100,
	submission_recorded_at: 100,
	task_id: "task",
} as const;
const legacy = {
	...image,
	provider: "toapis",
	model: "seedance-2-5",
	business_id: "siluet-1",
} as const;
const h3 = { ...image, model: "h3-max", video_terms: "[]" };

test("legacy business_id row is a video job", () => {
	expect(isVideoJob(legacy)).toBe(true);
	expect(hasCorrelation(legacy)).toBe(true);
	expect(jobCredentialAccess(legacy)).toBe("toapis-video");
	expect(isVideoJob(h3)).toBe(true);
	expect(hasCorrelation(h3)).toBe(false);
	expect(jobCredentialAccess(h3)).toBe("poyo-balance");
	expect(isVideoJob(image)).toBe(false);
	expect(jobCredentialAccess(image)).toBe("seedream");
	expect(jobCredentialAccess({ ...image, model: "z-image" })).toBe("poyo-balance");
	expect(isVideoJob(undefined)).toBe(false);
});

test("jobPollDeadline uses the video window only after a durable acknowledgement", () => {
	expect(jobPollDeadline(image)).toBe(120_100);
	expect(jobPollDeadline({ ...legacy, video_poll_deadline: 700 })).toBe(700);
	expect(jobPollDeadline(h3)).toBe(100 + videoJobPollingWindowMs);
	expect(jobPollDeadline({ ...h3, task_id: null })).toBe(120_100);
	expect(jobPollDeadline({ ...h3, submission_recorded_at: null })).toBe(120_100);
});

// Grep gate: video behaviour reads isVideoJob or hasCorrelation, never a business_id
// truthiness test. SQL tests of business_id stay in the store's ToAPIs correlation sites.
test("no business_id truthiness test remains outside the job helpers", async () => {
	const truthiness =
		/!\s*[\w.?]*\.business_id\b(?!\s*[!=]=)|\.business_id\s*(?:\?(?![.?])|&&|\|\|)|(?:&&|\|\|)\s*[\w.?]*\.business_id\b(?!\s*[!=]=)|\?\.business_id\b/;
	const sqlTest = /\bbusiness_id IS (?:NOT )?NULL/g;
	const offenders: string[] = [];
	const sqlSites: Record<string, number> = {};
	const root = resolve(import.meta.dir, "../../../..");
	for await (const path of new Glob("src/**/*.{ts,svelte}").scan(root)) {
		// Released migrations are fixed SQL text, so they spell the video test out.
		if (
			path.endsWith(".test.ts") ||
			path.endsWith("video-schema.ts") ||
			path.endsWith("video-profile-rearm.ts") ||
			path.endsWith("video-save-limit-schema.ts")
		)
			continue;
		const text = await Bun.file(resolve(root, path)).text();
		if (truthiness.test(text)) offenders.push(path);
		const count = text.match(sqlTest)?.length ?? 0;
		if (count) sqlSites[path] = count;
	}
	expect(offenders).toEqual([]);
	// videoJobSql, jobsNeedCredential, recordSubmission (twice), recordMissingCredential and
	// identityConflict.
	expect(sqlSites).toEqual({ "src/lib/server/db/image-job-store.ts": 6 });
});
