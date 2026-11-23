import { afterEach, beforeEach, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { sql } from "drizzle-orm";
import { createOwnerDirectory } from "../../../../tests/fixtures/owner-directory";
import { type ImageJob, imageJobStore } from "./image-job-store";
import { type Installation, openInstallation } from "./installation";
import { providerStore } from "./provider-store";
import { saveIntentStore } from "./save-intent";

let directory: string;
let installation: Installation;
const now = 1_800_000_000_000;

beforeEach(async () => {
	directory = await createOwnerDirectory();
	installation = await openInstallation(directory);
	await providerStore(installation).save("poyo", "fixture-key", now, true, 0);
});
afterEach(async () => {
	await installation.close();
	await rm(directory, { recursive: true, force: true });
});

const run = (statement: ReturnType<typeof sql>) => installation.use((db) => db.run(statement));
const row = (id: string) =>
	installation.use((db) =>
		db.get<Pick<ImageJob, "save_due" | "save_hold" | "save_attempt" | "save_tries">>(
			sql`SELECT save_due, save_hold, save_attempt, save_tries FROM image_job WHERE id=${id}`,
		),
	);
async function insert(id: string, state = "running", extra?: ReturnType<typeof sql>) {
	await run(sql`INSERT INTO image_job
		(id,binding,provider,revision,quote,state,model,created_at,poll_deadline,submission_recorded_at,task_id)
		VALUES (${id},${id},'poyo',1,'{}',${state},'seedream-5.5',${now},${now + 120_000},${now},${`${id}-task`})`);
	if (extra) await run(extra);
}
const update = (state: "running" | "completed", note: ImageJob["pause_reason"] = null) => ({
	completedObservation: state === "completed",
	transientFailure: null,
	retry: null,
	queryAfter: 0,
	state,
	nextReadAt: now + 5_000,
	failures: 0,
	note,
	failureReason: null,
	billing: null,
	expiresAt: null,
	saveHold: null,
});
async function record(
	id: string,
	state: "running" | "completed",
	note: ImageJob["pause_reason"] = null,
) {
	const store = imageJobStore(installation);
	await run(sql`UPDATE image_job SET read_token='read' WHERE id=${id}`);
	const job = await store.get(id);
	if (!job) throw new Error("Missing fixture job.");
	return store.recordStatus(job, "read", now, update(state, note));
}

test("first completion arms once", async () => {
	await insert("job");
	expect(await record("job", "running")).toMatchObject({ armed: false });
	expect(await row("job")).toMatchObject({ save_due: null });
	expect(await record("job", "completed")).toMatchObject({ armed: true, pending: false });
	expect(await row("job")).toMatchObject({ save_due: now, save_hold: null, save_tries: 0 });
	await run(sql`UPDATE image_job SET save_due=${now + 60_000} WHERE id='job'`);
	expect(await record("job", "completed")).toMatchObject({ armed: false, pending: true });
	expect(await row("job")).toMatchObject({ save_due: now + 60_000 });
});

test("a link-less first completion records Download failed in the same commit", async () => {
	await insert("job");
	await run(sql`UPDATE image_job SET read_token='read' WHERE id='job'`);
	const store = imageJobStore(installation);
	const job = await store.get("job");
	if (!job) throw new Error("Missing fixture job.");
	expect(
		await store.recordStatus(job, "read", now, { ...update("completed"), saveHold: "failed" }),
	).toMatchObject({ armed: false, pending: false });
	expect(await row("job")).toMatchObject({ save_due: null, save_hold: "failed", save_tries: 0 });
	// A later link-less read leaves the hold alone.
	expect(await record("job", "completed")).toMatchObject({ armed: false, pending: false });
	expect(await row("job")).toMatchObject({ save_due: null, save_hold: "failed" });
});

test("Refresh on a saved, unavailable or removed job arms nothing", async () => {
	for (const [id, gallery, hold] of [
		["saved", "saved", null],
		["unavailable", "unavailable", null],
		["removed", null, "removed"],
	] as const) {
		await insert(
			id,
			"completed",
			hold ? sql`UPDATE image_job SET save_hold=${hold} WHERE id=${id}` : undefined,
		);
		if (gallery)
			await run(sql`INSERT INTO gallery_image (job_id,state,mime,width,height,size,digest,saved_at)
				VALUES (${id},${gallery},'image/png',1,1,1,'d',1)`);
		expect(await record(id, "completed")).toMatchObject({
			armed: false,
			pending: false,
			resumed: false,
		});
		expect(await row(id)).toMatchObject({ save_due: null, save_hold: hold });
	}
	// A first completion with a Gallery row or a hold records no intent either.
	await insert("late");
	await run(sql`INSERT INTO gallery_image (job_id,state,mime,width,height,size,digest,saved_at)
		VALUES ('late','saved','image/png',1,1,1,'d',1)`);
	expect(await record("late", "completed")).toMatchObject({ armed: false });
	expect(await row("late")).toMatchObject({ save_due: null });
});

test("a Refresh that leaves a read pause resumes a pending intent", async () => {
	await insert("job");
	await record("job", "completed", "unknown-status");
	expect(await record("job", "completed", "unknown-status")).toMatchObject({
		pending: true,
		resumed: false,
	});
	expect(await record("job", "completed")).toMatchObject({ pending: true, resumed: true });
});

test("every outcome is fenced by its attempt token", async () => {
	const saves = saveIntentStore(installation);
	await insert("job", "completed", sql`UPDATE image_job SET save_due=${now} WHERE id='job'`);
	expect(await saves.claim("job", "early", now - 1)).toBeUndefined();
	expect((await saves.pendingSaves(now)).map((job) => job.id)).toEqual(["job"]);
	expect(await saves.claim("job", "first", now)).toMatchObject({
		id: "job",
		save_attempt: "first",
	});
	expect(await saves.claim("job", "second", now)).toBeUndefined();
	expect(await saves.pendingSaves(now)).toEqual([]);
	expect(await saves.defer("job", "first", now + 30_000, 1)).toBe("done");
	expect(await row("job")).toEqual({
		save_due: now + 30_000,
		save_hold: null,
		save_attempt: null,
		save_tries: 1,
	});
	expect(await saves.nextDue(now)).toBe(now + 30_000);
	expect(await saves.claim("job", "second", now + 30_000)).toBeTruthy();
	// Remove records its hold and clears the attempt; the old attempt can no longer write.
	await run(
		sql`UPDATE image_job SET save_hold='removed', save_due=NULL, save_attempt=NULL WHERE id='job'`,
	);
	for (const outcome of [
		() => saves.defer("job", "second", now + 60_000, 2),
		() => saves.hold("job", "second", "failed"),
		() => saves.expire("job", "second", now),
		() => saves.release("job", "second"),
	])
		expect(await outcome()).toBe("fenced");
	expect(await row("job")).toEqual({
		save_due: null,
		save_hold: "removed",
		save_attempt: null,
		save_tries: 1,
	});
	expect(await saves.nextDue(now)).toBeNull();
});

test("a worker pass clears only claims that belong to no running attempt", async () => {
	const saves = saveIntentStore(installation);
	for (const id of ["running", "stale"])
		await insert(id, "completed", sql`UPDATE image_job SET save_due=${now} WHERE id=${id}`);
	await saves.claim("running", "live", now);
	await saves.claim("stale", "lost", now);
	await saves.clearAbandoned(["live"]);
	expect(await row("running")).toMatchObject({ save_attempt: "live", save_due: now });
	expect(await row("stale")).toMatchObject({ save_attempt: null, save_due: now });
});

test("startup clears abandoned attempts and keeps their intent, tries and holds", async () => {
	const saves = saveIntentStore(installation);
	await insert(
		"job",
		"completed",
		sql`UPDATE image_job SET save_due=${now}, save_tries=2 WHERE id='job'`,
	);
	await saves.claim("job", "crashed", now);
	await saves.clearAbandoned();
	expect(await row("job")).toEqual({
		save_due: now,
		save_hold: null,
		save_attempt: null,
		save_tries: 2,
	});
	await saves.claim("job", "next", now);
	expect(await saves.release("job", "next")).toBe("done");
	expect(await saves.hold("job", "next", "webm")).toBe("fenced");
	await saves.claim("job", "last", now);
	expect(await saves.hold("job", "last", "webm")).toBe("done");
	expect(await row("job")).toEqual({
		save_due: null,
		save_hold: "webm",
		save_attempt: null,
		save_tries: 2,
	});
	await insert(
		"expiring",
		"completed",
		sql`UPDATE image_job SET save_due=${now}, expires_at=${now - 1} WHERE id='expiring'`,
	);
	await saves.claim("expiring", "token", now);
	expect(await saves.expire("expiring", "token", now)).toBe("done");
	expect(await row("expiring")).toMatchObject({ save_due: null, save_hold: null });
});

test("expiry needs both the attempt's token and an expired link", async () => {
	const saves = saveIntentStore(installation);
	await insert(
		"expired",
		"completed",
		sql`UPDATE image_job SET save_due=${now}, expires_at=${now - 1} WHERE id='expired'`,
	);
	await saves.claim("expired", "current", now);
	// A stale token cannot expire a row another attempt holds.
	expect(await saves.expire("expired", "stale", now)).toBe("fenced");
	expect(await row("expired")).toMatchObject({ save_due: now, save_attempt: "current" });
	await insert(
		"live",
		"completed",
		sql`UPDATE image_job SET save_due=${now}, expires_at=${now + 60_000} WHERE id='live'`,
	);
	await saves.claim("live", "token", now);
	// A link that has not expired keeps the intent; only the claim is given back.
	expect(await saves.expire("live", "token", now)).toBe("fenced");
	expect(await row("live")).toMatchObject({ save_due: now, save_attempt: null });
});

test("retry arms each eligible case and refuses the rest", async () => {
	const saves = saveIntentStore(installation);
	const later = now + 9_000;
	const eligible = {
		failed: sql`UPDATE image_job SET save_hold='failed', save_tries=3, next_read_at=${later} WHERE id='failed'`,
		removed: sql`UPDATE image_job SET save_hold='removed' WHERE id='removed'`,
		unavailable: sql`INSERT INTO gallery_image (job_id,state,mime,width,height,size,digest,saved_at)
			VALUES ('unavailable','unavailable','image/png',1,1,1,'d',1)`,
	};
	for (const [id, setup] of Object.entries(eligible)) {
		await insert(id, "completed", setup);
		expect(await saves.retry(id, now), id).toBe(true);
		expect(await row(id), id).toEqual({
			save_due: id === "failed" ? later : now,
			save_hold: null,
			save_attempt: null,
			save_tries: 0,
		});
	}
	expect(
		await installation.use((db) =>
			db.all(sql`SELECT job_id FROM gallery_image WHERE job_id='unavailable'`),
		),
	).toEqual([]);
	const ineligible = {
		running: [undefined, "running"],
		pending: [sql`UPDATE image_job SET save_due=${now} WHERE id='pending'`],
		claimed: [sql`UPDATE image_job SET save_hold='failed', save_attempt='a' WHERE id='claimed'`],
		unsupported: [sql`UPDATE image_job SET save_hold='unsupported' WHERE id='unsupported'`],
		webm: [sql`UPDATE image_job SET save_hold='webm' WHERE id='webm'`],
		expired: [sql`UPDATE image_job SET save_hold='failed', expires_at=${now} WHERE id='expired'`],
		paused: [
			sql`UPDATE image_job SET save_hold='failed', pause_reason='authorization' WHERE id='paused'`,
		],
		key: [sql`UPDATE image_job SET save_hold='failed', revision=2 WHERE id='key'`],
		saved: [
			sql`INSERT INTO gallery_image (job_id,state,mime,width,height,size,digest,saved_at)
			VALUES ('saved','saved','image/png',1,1,1,'d',1)`,
		],
	} as const;
	for (const [id, [setup, state]] of Object.entries(ineligible)) {
		await insert(id, state ?? "completed", setup);
		const before = await row(id);
		expect(await saves.retry(id, now), id).toBe(false);
		expect(await row(id), id).toEqual(before);
	}
	expect(await saves.retry("missing", now)).toBe(false);
});

test("jobs need the credential while an unexpired completed result is pending or failed", async () => {
	const store = imageJobStore(installation);
	const holds = ["removed", "unsupported", "webm"] as const;
	for (const hold of holds)
		await insert(hold, "completed", sql`UPDATE image_job SET save_hold=${hold} WHERE id=${hold}`);
	await insert("saved", "completed");
	await run(sql`INSERT INTO gallery_image (job_id,state,mime,width,height,size,digest,saved_at)
		VALUES ('saved','saved','image/png',1,1,1,'d',1)`);
	await insert("unavailable", "completed");
	await run(sql`INSERT INTO gallery_image (job_id,state,mime,width,height,size,digest,saved_at)
		VALUES ('unavailable','unavailable','image/png',1,1,1,'d',1)`);
	await insert("done", "completed");
	expect(await store.needsCredential("poyo", now)).toBe(false);
	for (const setup of [
		sql`UPDATE image_job SET save_due=${now} WHERE id='done'`,
		sql`UPDATE image_job SET save_due=NULL, save_hold='failed' WHERE id='done'`,
	]) {
		await run(setup);
		expect(await store.needsCredential("poyo", now)).toBe(true);
		await run(sql`UPDATE image_job SET expires_at=${now} WHERE id='done'`);
		expect(await store.needsCredential("poyo", now)).toBe(false);
		expect(await store.needsCredential("poyo", now - 1)).toBe(true);
		await run(sql`UPDATE image_job SET expires_at=NULL WHERE id='done'`);
	}
	// Settings uses the same rule when it removes a key or verifies a replacement.
	const providers = providerStore(installation);
	expect(await providers.remove("poyo", true, now)).toBe("job-warning");
	expect(await providers.save("poyo", "replacement", now, true, 1, true)).toBe("job-warning");
	await run(sql`UPDATE image_job SET expires_at=${now} WHERE id='done'`);
	expect(await providers.save("poyo", "replacement", now, true, 1, true)).toBe(true);
	expect(await providers.remove("poyo", true, now)).toBeUndefined();
});
