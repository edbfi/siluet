import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import { sql } from "drizzle-orm";
import { createOwnerDirectory } from "../../../../../tests/fixtures/owner-directory";
import { notCleanedLead, originalRotationNote } from "../../../shared/image-studio/file-edit";
import { createSeedreamDraft } from "../../../shared/image-studio/seedream";
import type { MediaDescriptor } from "../../../shared/media-staging/descriptor";
import { accessStore } from "../../db/access-store";
import { imageJobStore } from "../../db/image-job-store";
import { mediaCleaning } from "../../db/media-cleaning";
import { providerStore } from "../../db/provider-store";
import { openRuntimeInstallation, type RuntimeInstallation } from "../../db/runtime-installation";
import type { FileStages } from "../media-staging/stages";
import { fileDispatcher } from "./dispatch";
import { createFileQueue } from "./queue";
import { type FileRequest, parseFileRequest } from "./request";
import { clickFor, orderedBody, parsedRequest } from "./request.fixture";
import { openTestStages } from "./stages.fixture";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const step of cleanup.splice(0).reverse()) await step();
});

const scope = { owner: "creator", session: "session-digest", draft: crypto.randomUUID() };
const attached = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);

type Sent = { upload: Uint8Array[]; edit: number };

async function harness(root?: string) {
	const directory = root ?? (await createOwnerDirectory());
	if (!root) cleanup.push(() => rm(directory, { recursive: true, force: true }));
	const db = await openRuntimeInstallation(directory);
	const stages = await openTestStages(db);
	const sent: Sent = { upload: [], edit: 0 };
	const credentials = providerStore(db);
	if (!root) {
		await accessStore(db).claim(scope.owner, "unused", scope.session, Date.now(), () => {});
		await credentials.save("toapis", "reviewed-key", Date.now(), true, 0);
	}
	const settled: Promise<unknown>[] = [];
	const nonce = crypto.randomUUID();
	const dispatcher = fileDispatcher(db, nonce, () => {}, {
		pin: async () => async () => {
			throw new Error("unexpected transport");
		},
		async upload(_provider, _key, _stage, bytes) {
			sent.upload.push(new Uint8Array(bytes));
			return { kind: "ready", url: "https://storage.example.org/reference" };
		},
		async edit() {
			sent.edit++;
			return { kind: "accepted", taskId: "task" };
		},
	});
	const files = await createFileQueue(
		db,
		nonce,
		stages,
		credentials.credential,
		(...args) => {
			const work = dispatcher(...args);
			settled.push(work);
			return work;
		},
		{ loadFeeds: async () => ({}) },
	);
	const close = async () => {
		await Promise.allSettled(settled);
		await files.close();
		await stages.close();
		await db.close();
	};
	return { directory, db, stages, files, sent, settled, close };
}

async function stage(
	stages: FileStages,
	db: RuntimeInstallation,
	{ transform = "none", rotated = false, mime = "image/png" } = {},
) {
	const { revision } = await mediaCleaning(db).read();
	return stages.put(scope, {
		bytes: new Uint8Array(attached),
		digest: createHash("sha256").update(attached).digest("hex"),
		size: attached.length,
		mime: mime as "image/png",
		transform: transform as "none",
		revision,
		rotated,
	});
}

function request(stageDescriptor: MediaDescriptor, provider: "poyo" | "toapis" = "toapis") {
	return parsedRequest(
		orderedBody({ ...createSeedreamDraft(provider, "edit"), prompt: "Paint the harbour" }, [
			stageDescriptor,
		]),
	);
}

async function reviewed(files: Awaited<ReturnType<typeof createFileQueue>>, live: FileRequest) {
	const terms = await files.review(scope, live);
	if (!("token" in terms)) throw new Error(`Review refused: ${JSON.stringify(terms)}`);
	return { terms, click: clickFor(live, terms) };
}

test("count 2 or one retry is invalid for a file", async () => {
	const h = await harness();
	cleanup.push(h.close);
	const staged = await stage(h.stages, h.db);
	const draft = { ...createSeedreamDraft("toapis", "edit"), prompt: "x" };
	expect(parseFileRequest(orderedBody(draft, [staged], { count: 2 }))).toBeNull();
	expect(parseFileRequest(orderedBody(draft, [staged], { retryLimit: 1 }))).toBeNull();
	expect(
		parseFileRequest(
			orderedBody(draft, [{ ...staged, transform: undefined } as unknown as MediaDescriptor]),
		),
	).toBeNull();
});

test("cleaning off sends the attached bytes once, and the terms carry the setting and disclosure", async () => {
	const h = await harness();
	cleanup.push(h.close);
	await mediaCleaning(h.db).set(false, 0);
	const staged = await stage(h.stages, h.db, { transform: "original" });
	const { terms, click } = await reviewed(h.files, request(staged));
	expect(terms.editDisclosure.some((line) => line.startsWith(notCleanedLead))).toBe(true);
	expect(terms.editDisclosure).not.toContain(originalRotationNote);
	const queued = await h.files.submit(scope, click);
	expect(queued).toHaveProperty("jobId");
	await Promise.allSettled(h.settled);
	expect(h.sent.upload).toEqual([attached]);
	expect(h.sent.edit).toBe(1);
});

test("a cleaned Review never shows Not cleaned and a mode that disagrees with the setting has no terms", async () => {
	const h = await harness();
	cleanup.push(h.close);
	const cleaned = await stage(h.stages, h.db);
	const { terms } = await reviewed(h.files, request(cleaned));
	expect(terms.editDisclosure.some((line) => line.startsWith(notCleanedLead))).toBe(false);
	// An original staged while the setting says on (a forged or stale copy) cannot be reviewed.
	const original = await stage(h.stages, h.db, { transform: "original" });
	expect(await h.files.review(scope, request(original))).toEqual({
		error: "stale",
		positions: [1],
	});
});

test("a rotated original's terms carry the orientation note and it queues", async () => {
	const h = await harness();
	cleanup.push(h.close);
	await mediaCleaning(h.db).set(false, 0);
	const staged = await stage(h.stages, h.db, {
		transform: "original",
		rotated: true,
		mime: "image/jpeg",
	});
	const { terms, click } = await reviewed(h.files, request(staged));
	expect(terms.editDisclosure).toContain(originalRotationNote);
	expect(await h.files.submit(scope, click)).toHaveProperty("jobId");
});

test("a setting change between Review and Queue sends nothing", async () => {
	const h = await harness();
	cleanup.push(h.close);
	const staged = await stage(h.stages, h.db);
	const { click } = await reviewed(h.files, request(staged));
	const flipped = await mediaCleaning(h.db).set(false, 0);
	// Without the stage store's retirement, the claim itself re-reads the setting.
	const restage = { error: "stale" as const, positions: [1] };
	expect(await h.files.submit(scope, click)).toEqual(restage);
	await h.stages.retireAll(flipped.revision);
	expect(await h.files.submit(scope, click)).toEqual(restage);
	expect(await h.files.review(scope, request(staged))).toEqual(restage);
	expect(h.sent).toEqual({ upload: [], edit: 0 });
	expect(await imageJobStore(h.db).list()).toEqual([]);
});

test("a copy over Poyo.ai's limit is refused at Review with the limit and size", async () => {
	const h = await harness();
	cleanup.push(h.close);
	const big = new Uint8Array(10_000_001);
	big.set(attached);
	const staged = await h.stages.put(scope, {
		bytes: big,
		digest: createHash("sha256").update(big).digest("hex"),
		size: big.length,
		mime: "image/png",
		transform: "none",
		revision: 0,
		rotated: false,
	});
	const live = request(staged);
	const poyo = request(staged, "poyo");
	expect(await h.files.review(scope, poyo)).toEqual({
		error: "limit",
		provider: "poyo",
		limit: 10_000_000,
		size: 10_000_001,
		position: 1,
	});
	expect(await h.files.review(scope, live)).toHaveProperty("token");
});

test("a claimed replay after a setting change and a restart keeps its job, with one upload and one edit", async () => {
	const h = await harness();
	const staged = await stage(h.stages, h.db);
	const { click } = await reviewed(h.files, request(staged));
	const first = await h.files.submit(scope, click);
	if (!("jobId" in first)) throw new Error("Expected a job");
	await Promise.allSettled(h.settled);
	await mediaCleaning(h.db).set(false, 0);
	expect(await h.files.submit(scope, click)).toEqual(first);
	await h.close();
	const again = await harness(h.directory);
	cleanup.push(async () => {
		await again.close();
		await rm(h.directory, { recursive: true, force: true });
	});
	expect(await again.files.submit(scope, click)).toEqual(first);
	expect(h.sent.upload).toHaveLength(1);
	expect(h.sent.edit).toBe(1);
	expect(again.sent).toEqual({ upload: [], edit: 0 });
	expect(
		await again.db.use((db) =>
			db.get(sql`SELECT file_phase FROM image_job WHERE id=${first.jobId}`),
		),
	).toEqual({ file_phase: "edit-recorded" });
});
