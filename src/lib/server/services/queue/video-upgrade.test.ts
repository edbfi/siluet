import { afterEach, beforeEach, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { sql } from "drizzle-orm";
import { createOwnerDirectory } from "../../../../../tests/fixtures/owner-directory";
import { h3MaxOperation, seedanceOperation } from "../../../shared/media-catalog/registry";
import { parseVideo } from "../../../shared/video-studio/request";
import { videoDefaults } from "../../../shared/video-studio/seedance";
import { type Installation, openInstallation } from "../../db/installation";
import { installationMigrations } from "../../db/migrations";
import { providerStore } from "../../db/provider-store";
import { createJobTracking } from "../jobs/tracking";
import { createVideoAccess } from "../providers/video-access";
import { reviewSigner } from "./review-signature";
import { createVideoQueue, type VideoTarget } from "./video";

// The exact inputs a released Seedance Review signs since #55 (no verifier identity), kept as
// literals. The migration list is unchanged since #37.
const released = {
	migrations: [
		"20261121000000_owner_access",
		"20261121191912_provider_credentials",
		"20261121223139_first_saved_image",
		"20261122000549_seedream_reference_failure",
		"20261122030400_image_job_operation",
		"20261122120000_live_image_batches",
		"20261122121000_first_saved_video",
		"20261122122000_owner_authenticator",
	],
	key: {
		provider: "toapis",
		model: "seedance-2-5",
		route: "POST /v1/videos/generations",
		operation: "text-to-video",
	},
	disclosures: [
		"The prompt is sent to ToAPIs for one potentially billable submission.",
		"The total charge is unknown. Fallback may be available on eligible accounts and regions. Its route and price are unknown.",
		"Gallery saves complete H.264/AAC MP4 files within its size, dimension and 12-second limits. A completed billable clip outside them stays with the provider.",
	],
	body: {
		model: "seedance-2-5",
		prompt: "Rotate",
		video_operation: "generate",
		duration: 5,
		aspect_ratio: "16:9",
		resolution: "720p",
		generate_audio: true,
		output_format: "mp4",
		return_last_frame: false,
		disable_nsfw: false,
	},
};
const checkedAt = 2;
let directory: string;
let db: Installation;
const now = Date.parse("2026-11-22T00:00:00Z");

beforeEach(async () => {
	directory = await createOwnerDirectory();
	db = await openInstallation(directory);
});
afterEach(async () => {
	await db.close();
	await rm(directory, { recursive: true, force: true });
});

function seedance() {
	const input = parseVideo({
		draft: { ...videoDefaults, prompt: " Rotate " },
		operationKey: seedanceOperation.key,
		count: 1,
		retryLimit: 0,
		acceptTerms: true,
	});
	if (!input) throw new Error("Invalid Seedance fixture.");
	return input;
}

test("a released Seedance Review token keeps its HMAC bytes and replays without a second POST", async () => {
	expect(Object.keys(installationMigrations)).toEqual(released.migrations);
	const store = providerStore(db);
	await store.save("toapis", "video-only", now, false, 0);
	await store.save("poyo", "balance-only", now, false, 0);
	await db.use((c) =>
		c.run(sql`INSERT INTO model_access VALUES ('toapis','seedance-2-5',1,'eligible',${checkedAt})`),
	);
	const sign = await reviewSigner(db);
	const dispatched: VideoTarget[] = [];
	const queue = await createVideoQueue(
		db,
		createVideoAccess(db, store),
		async (_id, _key, target) => {
			dispatched.push(target);
		},
		async () => ({}),
		() => now,
	);
	const input = seedance();
	expect<unknown>(input.body).toEqual(released.body);
	expect<unknown>(input.operation.key).toEqual(released.key);

	// R3's Seedance Review signs the same fields in the same order as the released build.
	const review = await queue.review("owner", input);
	const [id, digest, signed] = review.token.split(".");
	const termsReleased = sign(
		"video-terms-v1",
		1,
		"eligible",
		checkedAt,
		review.quote,
		released.disclosures,
		[],
	);
	expect(digest).toBe(termsReleased);
	expect(signed).toBe(
		sign("video-review-v1", id, termsReleased, "owner", released.key, released.body, 1, 0),
	);

	// A Review token issued by the released build and not yet queued claims once on R3.
	const pending = crypto.randomUUID();
	const pendingToken = [
		pending,
		termsReleased,
		sign("video-review-v1", pending, termsReleased, "owner", released.key, released.body, 1, 0),
	].join(".");
	const click = { ...input, token: pendingToken };
	expect(await queue.submit("owner", click)).toEqual({ jobId: pending });
	expect(await queue.submit("owner", click)).toEqual({ jobId: pending });
	expect(dispatched).toHaveLength(1);
	expect(dispatched[0]).toMatchObject({ provider: "toapis", body: released.body });

	// A job #37 already claimed (a legacy row without video terms) replays with no POST.
	const claimed = crypto.randomUUID();
	const claimedSignature = sign(
		"video-review-v1",
		claimed,
		termsReleased,
		"owner",
		released.key,
		released.body,
		1,
		0,
	);
	await db.use((c) =>
		c.run(sql`INSERT INTO image_job(id,binding,provider,revision,model,operation,quote,accepted_unknown,state,created_at,poll_deadline,submission_recorded_at,task_id,business_id)
			VALUES(${claimed},${sign("video-accepted-v1", claimedSignature, true)},'toapis',1,'seedance-2-5','text-to-video','{}',1,'completed',1,120002,2,'video-task','video-business')`),
	);
	const legacy = { ...input, token: [claimed, termsReleased, claimedSignature].join(".") };
	expect(await queue.submit("owner", legacy)).toEqual({ jobId: claimed });
	expect(dispatched).toHaveLength(1);
	const tracking = createJobTracking(db, store, { now: () => now });
	try {
		expect(await tracking.isVideo(claimed)).toBe(true);
	} finally {
		tracking.close();
	}

	// An H3 job runs alongside the legacy Seedance rows.
	const h3 = parseVideo({
		draft: { prompt: "A paper boat", duration: 5, resolution: "768p", aspect_ratio: "16:9" },
		operationKey: h3MaxOperation.key,
		count: 1,
		retryLimit: 0,
		acceptTerms: true,
	});
	if (!h3) throw new Error("Invalid H3 fixture.");
	const h3Review = await queue.review("owner", h3);
	expect(await queue.submit("owner", { ...h3, token: h3Review.token })).toHaveProperty("jobId");
	expect(dispatched.map((target) => target.provider)).toEqual(["toapis", "poyo"]);
});
