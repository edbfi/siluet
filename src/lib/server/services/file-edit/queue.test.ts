import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import { sql } from "drizzle-orm";
import { createOwnerDirectory } from "../../../../../tests/fixtures/owner-directory";
import { filePlaceholder } from "../../../shared/image-studio/file-edit";
import { createSeedreamDraft } from "../../../shared/image-studio/seedream";
import type { PricingFeeds } from "../../../shared/pricing/feeds";
import { accessStore, insertSession } from "../../db/access-store";
import { imageJobStore } from "../../db/image-job-store";
import { providerStore } from "../../db/provider-store";
import { openRuntimeInstallation } from "../../db/runtime-installation";
import { loadBundledPricing } from "../pricing/studio-feeds";
import { fileDispatcher } from "./dispatch";
import { createFileQueue } from "./queue";
import { parseFileRequest } from "./request";
import { openTestStages } from "./stages.fixture";

test("one claim returns while upload is pending, keeps the reviewed key and replays after restart", async () => {
	const root = await createOwnerDirectory();
	let db = await openRuntimeInstallation(root);
	let stages = await openTestStages(db);
	const clock = Date.now();
	const scope = { owner: "creator", session: "session-digest", draft: crypto.randomUUID() };
	const received: string[] = [];
	try {
		const credentials = providerStore(db);
		await accessStore(db).claim(scope.owner, "unused", scope.session, clock, () => {});
		await credentials.save("poyo", "reviewed-credential", clock, true, 0);
		const bytes = new Uint8Array([4, 2]);
		const stage = await stages.put(scope, {
			bytes,
			digest: createHash("sha256").update(bytes).digest("hex"),
			size: bytes.length,
			mime: "image/png",
			transform: "none",
			revision: 0,
			rotated: false,
		});
		const draft = {
			...createSeedreamDraft("poyo", "edit"),
			prompt: "Draw a peaceful meadow",
			references: [{ kind: "upload", url: filePlaceholder }],
		};
		const request = parseFileRequest({
			stage,
			draft,
			count: 1,
			retryLimit: 0,
			acceptUnknown: false,
		});
		if (!request) throw new Error("Invalid fixture");
		const release = Promise.withResolvers<void>();
		const started = Promise.withResolvers<void>();
		const beforeUpload = Promise.withResolvers<void>();
		const continueUpload = Promise.withResolvers<void>();
		const posts: string[] = [];
		const dispatch = fileDispatcher(db, "runtime", () => {}, {
			pin: async () => async () => {
				throw new Error("unexpected transport");
			},
			balance: async (key) => {
				beforeUpload.resolve();
				await continueUpload.promise;
				received.push(key);
				return "12";
			},
			async upload(_provider, key, _stage, body) {
				received.push(key);
				posts.push("upload");
				expect([...body]).toEqual([...bytes]);
				started.resolve();
				await release.promise;
				return { kind: "ready", url: "https://storage.example.org/ref" };
			},
			async edit(_provider, key, wire) {
				received.push(key);
				posts.push("edit");
				expect(JSON.stringify(wire.body)).toContain("https://storage.example.org/ref");
				return { kind: "accepted", taskId: "fixture-id" };
			},
		});
		const api = await createFileQueue(db, "runtime", stages, credentials.credential, dispatch, {
			loadFeeds: async () => ({}),
		});
		const review = await api.review(scope, request);
		const other = await api.review(scope, request);
		if (!("token" in review) || !("token" in other)) throw new Error("Missing file Review");
		const click = parseFileRequest({
			draft,
			count: 1,
			retryLimit: 0,
			stage: review.stage,
			token: review.token,
			acceptUnknown: true,
		});
		if (!click) throw new Error("Invalid browser Queue fixture");
		expect(await api.submit(scope, { ...click, acceptUnknown: false })).toEqual({
			error: "invalid",
		});
		expect(await api.submit(scope, { ...click, stage: { ...click.stage, size: 3 } })).toEqual({
			error: "invalid",
		});
		expect(await api.submit({ ...scope, session: "other" }, click)).toEqual({ error: "invalid" });
		// Legacy single-file jobs share this provider's rolling upload allowance.
		await db.use((tx) =>
			tx.run(
				sql`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<10) INSERT INTO poyo_upload_start SELECT ${clock} FROM n`,
			),
		);
		expect(await api.submit(scope, click)).toEqual({ error: "cooldown", until: clock + 60000 });
		expect(await imageJobStore(db).list()).toEqual([]);
		expect(await stages.preview(scope, stage.handle)).toBeTruthy();
		await db.use((tx) => tx.run(sql`DELETE FROM poyo_upload_start`));
		// An exhausted generation window does not block the upload. It clears before the edit.
		await db.use((tx) =>
			tx.run(
				sql`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<20) INSERT INTO provider_start SELECT 'poyo','submit',${clock} FROM n`,
			),
		);
		const [one, two] = await Promise.all([api.submit(scope, click), api.submit(scope, click)]);
		expect(one).toEqual(two);
		if (!("jobId" in one)) throw new Error("No durable job");
		try {
			await beforeUpload.promise;
			await credentials.save("poyo", "replacement", clock + 1, true, 1);
			continueUpload.resolve();
			await started.promise;
			expect(posts).toEqual(["upload"]);
			expect(
				await db.use((tx) => tx.get(sql`SELECT count(*) AS n FROM poyo_upload_start`)),
			).toEqual({ n: 1 });
			await db.use((tx) => tx.run(sql`DELETE FROM provider_start WHERE kind='submit'`));
			expect(await api.submit(scope, { ...click, stage: other.stage, token: other.token })).toEqual(
				{ error: "stale" },
			);
			await credentials.remove("poyo");
		} finally {
			continueUpload.resolve();
			release.resolve();
		}
		await api.close();
		// Shutting down is never a definite refusal: the browser keeps a claimed
		// request for its exact Retry after the restart.
		expect(await api.submit(scope, click)).toEqual({ error: "closing" });
		expect(posts).toEqual(["upload", "edit"]);
		expect(received).toEqual(["reviewed-credential", "reviewed-credential", "reviewed-credential"]);
		expect(await imageJobStore(db).get(one.jobId)).toMatchObject({
			state: "waiting",
			file_phase: "edit-recorded",
			wallet_open: 1,
			task_id: "fixture-id",
		});
		await stages.close();
		await db.close();
		db = await openRuntimeInstallation(root);
		stages = await openTestStages(db);
		const reopened = await createFileQueue(
			db,
			"next",
			stages,
			async () => {
				throw new Error("Replay touched the removed credential");
			},
			async () => {
				throw new Error("Unexpected replay dispatch");
			},
		);
		expect(await reopened.submit(scope, click)).toEqual(one);
		const next = { ...scope, session: "subsequent-owner-session" };
		await db.use((tx) => tx.run(insertSession(next.session, Date.now())));
		expect(await reopened.submit(next, click)).toEqual(one);
		expect(
			await reopened.submit(next, { ...click, draft: { ...click.draft, prompt: "changed" } }),
		).toEqual({ error: "invalid" });
		expect(await reopened.submit({ ...next, owner: "another" }, click)).not.toEqual(one);
		await accessStore(db).revoke(scope.session);
		expect(await reopened.submit(scope, click)).toEqual({ error: "invalid" });
		await db.use((tx) => tx.run(sql`UPDATE owner_security SET recovery_required=1`));
		expect(await reopened.submit(next, click)).not.toEqual(one);
		await reopened.close();
	} finally {
		await stages.close();
		await db.close();
		await rm(root, { recursive: true, force: true });
	}
});

test("revocation, changed terms and replacement prevent first use without dispatch", async () => {
	const root = await createOwnerDirectory();
	const db = await openRuntimeInstallation(root);
	let now = Date.now();
	const stages = await openTestStages(db, { now: () => now });
	const credentials = providerStore(db);
	const scope = { owner: "creator", session: "fixture-session", draft: crypto.randomUUID() };
	const bytes = new Uint8Array([77, 88]);
	const media = {
		bytes,
		digest: createHash("sha256").update(bytes).digest("hex"),
		size: 2,
		mime: "image/jpeg" as const,
		transform: "none" as const,
		revision: 0,
		rotated: false,
	};
	let posts = 0;
	const loaded = Promise.withResolvers<void>(),
		release = Promise.withResolvers<void>();
	let pause = false;
	let feeds: PricingFeeds = {};
	try {
		await accessStore(db).claim(scope.owner, "unused", scope.session, now, () => {});
		await credentials.save("toapis", "first-credential", now, true, 0);
		const stage = await stages.put(scope, media);
		const draft = {
			...createSeedreamDraft("toapis", "edit"),
			prompt: "Color the tree",
			references: [{ kind: "upload", url: filePlaceholder }],
		};
		const body = { stage, draft, count: 1, retryLimit: 0, acceptUnknown: true };
		for (const changed of [
			{
				operationKey: {
					provider: "poyo",
					model: "z-image",
					route: "POST /api/generate/submit",
					operation: "reference-image-edit",
				},
				draft: { ...draft, provider: "poyo", options: {} },
			},
			{ retryLimit: 1 },
			{ count: 2 },
			{ draft: { ...draft, references: [...draft.references, ...draft.references] } },
			{ draft: { ...draft, references: [{ kind: "url", url: filePlaceholder }] } },
		]) {
			expect(parseFileRequest({ ...body, ...changed })).toBeNull();
		}
		const live = parseFileRequest(body);
		if (!live) throw new Error("Invalid fixture");
		const queue = await createFileQueue(
			db,
			"runtime",
			stages,
			credentials.credential,
			async (_id, _key, _live, held) => {
				posts++;
				held.release();
			},
			{
				loadFeeds: async () => {
					if (pause) {
						loaded.resolve();
						await release.promise;
					}
					return feeds;
				},
				now: () => now,
			},
		);
		const review = async () => {
			const reviewed = await queue.review(scope, live);
			if (!("token" in reviewed)) throw new Error("Missing reviewed terms");
			return { ...live, stage: reviewed.stage, token: reviewed.token };
		};
		const priceReview = await review();
		const rates = await loadBundledPricing("toapis");
		if (rates?.provider !== "toapis") throw new Error("Missing bundled rates");
		feeds = { toapis: rates };
		expect(await queue.submit(scope, priceReview)).toEqual({ error: "stale" });
		const paced = await review();
		await db.use((tx) =>
			tx.run(sql`UPDATE provider_gate SET submit_after=${now + 5000} WHERE provider='toapis'`),
		);
		expect(await queue.submit(scope, paced)).toMatchObject({
			error: "cooldown",
			until: now + 5000,
		});
		expect(await imageJobStore(db).list()).toEqual([]);
		expect(await stages.preview(scope, stage.handle)).toBeTruthy();
		await db.use((tx) =>
			tx.run(sql`UPDATE provider_gate SET submit_after=0 WHERE provider='toapis'`),
		);
		const changed = await review();
		await credentials.save("toapis", "second-credential", now + 1, true, 1);
		expect(await queue.submit(scope, changed)).toEqual({ error: "stale" });
		const first = await review();
		now += 100;
		const second = await review();
		now = first.stage.deadline;
		expect(await queue.submit(scope, first)).toEqual({ error: "stale" });
		pause = true;
		const waiting = queue.submit(scope, second);
		await loaded.promise;
		await stages.revoke(scope.session);
		await accessStore(db).revoke(scope.session);
		release.resolve();
		expect(await waiting).toEqual({ error: "stale" });
		await stages.revoke(scope.session);
		expect(await stages.preview(scope, stage.handle)).toBeNull();
		expect(await imageJobStore(db).list()).toEqual([]);
		expect(posts).toBe(0);
		await queue.close();
	} finally {
		release.resolve();
		await stages.close();
		await db.close();
		await rm(root, { recursive: true, force: true });
	}
});
