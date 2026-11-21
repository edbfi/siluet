import { describe, expect, test } from "bun:test";
import { runInNewContext } from "node:vm";

const script = await Bun.file(new URL("../state.js", import.meta.url)).text();
const timestamp = Date.UTC(2026, 0, 1);
const fixtures = [
	{
		id: "sample-image",
		title: "Sample still",
		kind: "image",
		mime: "image/png",
		src: "data:image/png;base64,c2FtcGxl",
		provider: "poyo",
		createdAt: timestamp,
	},
	{
		id: "sample-video",
		title: "Sample clip",
		kind: "video",
		mime: "video/webm",
		src: "./media/clip.webm",
		provider: "toapis",
		createdAt: timestamp - 1,
	},
];

function start(storage = new Map(), initialTime = timestamp + 60000, availableFixtures = fixtures) {
	let now = initialTime;
	let sequence = 0;
	const timers = new Map();
	const routes = [];
	const objectUrls = [];
	const revokedUrls = [];
	const requests = [];
	const errors = [];
	const window = {
		SiluetFixtures: availableFixtures,
		localStorage: {
			getItem: (key) => storage.get(key) ?? null,
			setItem: (key, value) => storage.set(key, value),
		},
		setTimeout(callback, delay) {
			const id = ++sequence;
			timers.set(id, { callback, time: now + delay });
			return id;
		},
		clearTimeout: (id) => timers.delete(id),
	};
	runInNewContext(script, {
		window,
		Date: { now: () => now },
		crypto,
		File,
		URL: class extends URL {
			static createObjectURL(blob) {
				objectUrls.push(blob);
				return `blob:test-${objectUrls.length}`;
			}
			static revokeObjectURL(url) {
				revokedUrls.push(url);
			}
		},
		fetch(url) {
			requests.push(url);
			throw new Error("Unexpected network request");
		},
		console: { error: (...args) => errors.push(args) },
		structuredClone,
	});
	window.Studio.go = (route) => routes.push(route);
	return {
		studio: window.Studio,
		views: window.StudioViews,
		routes,
		objectUrls,
		revokedUrls,
		requests,
		errors,
		storage,
		reopen: () => start(storage, now, availableFixtures),
		tick(ms) {
			const end = now + ms;
			while (true) {
				const next = [...timers].sort((a, b) => a[1].time - b[1].time)[0];
				if (!next || next[1].time > end) break;
				const [id, { callback, time }] = next;
				timers.delete(id);
				now = time;
				callback();
			}
			now = end;
		},
	};
}

const request = {
	provider: "poyo",
	model: "Z-Image",
	kind: "image",
	operation: "generate",
	prompt: "Lake at noon",
	sourceIds: [],
	options: { aspectRatio: "4:3", checker: false },
	count: 1,
	outcome: "success",
	title: "Lake at noon",
};

function createdJobs(studio) {
	return studio.jobs().filter(({ id }) => !id.startsWith("seed-"));
}

function job(studio, id) {
	return studio.jobs().find((entry) => entry.id === id);
}

const png = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82);

describe("synthetic studio state", () => {
	test("Gallery is notified once for each successful save, recovery and import", async () => {
		const { studio, tick } = start();
		studio.configure({ keys: { poyo: true } });
		const changes = [];
		studio.subscribe((topic, detail) => {
			if (topic === "assets") changes.push(detail);
		});
		studio.submit(request);
		const [failed] = studio.submit({ ...request, outcome: "download" });
		tick(30000);
		expect(changes).toEqual([undefined]);
		studio.recoverDownload(failed);
		expect(changes).toEqual([undefined, undefined]);
		await studio.importFiles([new File([png], "photo.png")]);
		expect(changes).toEqual([undefined, undefined, undefined]);
	});
	test("example results use their requested fixture and preserve staged input IDs", () => {
		const extra = { ...fixtures[0], id: "alternate-still", src: "./media/alternate.png" };
		const { studio, tick } = start(new Map(), undefined, [...fixtures, extra]);
		studio.configure({ keys: { poyo: true } });
		const source = studio.stageUrl("https://example.test/reference.png", "image");
		const [id] = studio.submit({
			...request,
			operation: "edit",
			fixtureId: "sample-image",
			sourceIds: [source.id],
		});
		tick(1200);
		const result = studio.assets().find((asset) => asset.id === `output-${id}`);
		expect(result?.src).toBe(fixtures[0].src);
		expect(result?.sourceIds).toEqual([source.id]);
		expect(() => studio.submit({ ...request, fixtureId: "sample-video" })).toThrow();
	});

	test("retry limits cap at three in settings and old persisted attempts", () => {
		const { studio, tick, storage, reopen } = start();
		studio.configure({ keys: { poyo: true }, retryEnabled: true, retryLimit: 9 });
		expect(studio.settings().retryLimit).toBe(3);
		studio.configure({ retryLimit: 0 });
		expect(studio.settings().retryLimit).toBe(0);

		const [id] = studio.submit({ ...request, outcome: "transient" });
		tick(1200);
		const key = "siluet.workspace.v1";
		const saved = JSON.parse(storage.get(key));
		saved.settings.retryLimit = 9;
		const attempt = saved.jobs.find((entry) => entry.id === id);
		Object.assign(attempt, { attempt: 4, retryLimit: 9, retryAt: timestamp + 70000 });
		storage.set(key, JSON.stringify(saved));

		const restored = reopen();
		expect(restored.studio.settings().retryLimit).toBe(3);
		expect(job(restored.studio, id)?.retryLimit).toBe(3);
		expect(job(restored.studio, id)?.retryPending).toBe(false);
		restored.tick(20000);
		expect(createdJobs(restored.studio)).toHaveLength(1);
	});

	test("one batch creates distinct jobs and each provider gets its own active slots", () => {
		const { studio, tick } = start();
		studio.configure({ keys: { poyo: true, toapis: true } });
		const ids = studio.submit({ ...request, count: 5 });
		const [next] = studio.submit(request);
		const [otherProvider] = studio.submit({ ...request, provider: "toapis" });

		expect(new Set(ids).size).toBe(5);
		expect(new Set(ids.map((id) => job(studio, id).batchId)).size).toBe(1);
		expect(job(studio, next).batchId).not.toBe(job(studio, ids[0]).batchId);
		tick(100);
		expect(ids.map((id) => job(studio, id).status)).toEqual([
			"running",
			"running",
			"queued",
			"queued",
			"queued",
		]);
		expect(job(studio, next).status).toBe("queued");
		expect(job(studio, otherProvider).status).toBe("running");
		tick(10000);
		expect(createdJobs(studio).every((entry) => entry.status === "completed")).toBe(true);
		expect(new Set(createdJobs(studio).map((entry) => entry.assetId)).size).toBe(7);
	});

	test("an in-progress batch keeps its authorized retry limit after settings change", () => {
		const { studio, tick } = start();
		studio.configure({ keys: { poyo: true }, retryEnabled: true, retryLimit: 2 });
		const roots = studio.submit({ ...request, count: 2, outcome: "transient" });
		studio.configure({ retryLimit: 0 });
		const [disabled] = studio.submit({ ...request, outcome: "transient" });
		tick(1500);
		expect(createdJobs(studio).filter((entry) => roots.includes(entry.rootId)).length).toBe(2);
		tick(30000);

		for (const rootId of roots) {
			const chain = createdJobs(studio).filter((entry) => entry.rootId === rootId);
			expect(chain.map((entry) => entry.attempt)).toEqual([3, 2, 1]);
			expect(chain.map((entry) => entry.parentId)).toEqual([chain[1].id, rootId, null]);
			expect(chain.every((entry) => entry.status === "failed" && entry.retryLimit === 2)).toBe(
				true,
			);
			expect(new Set(chain.map((entry) => entry.batchId)).size).toBe(1);
		}
		expect(createdJobs(studio).filter((entry) => entry.rootId === disabled).length).toBe(1);
	});

	test("only a confirmed transient technical failure schedules an automatic submission", () => {
		const { studio, tick } = start();
		studio.configure({ keys: { poyo: true }, retryEnabled: true });
		const outcomes = ["uncertain", "content", "download", "failure"];
		const ids = outcomes.map((outcome) => studio.submit({ ...request, outcome })[0]);
		tick(30000);
		expect(createdJobs(studio).length).toBe(4);
		expect(ids.map((id) => job(studio, id).status)).toEqual([
			"uncertain",
			"failed",
			"download-failed",
			"failed",
		]);

		expect(() => studio.retry(ids[2])).toThrow();
		studio.recoverDownload(ids[2]);
		studio.recoverDownload(ids[2]);
		expect(createdJobs(studio).length).toBe(4);
		expect(job(studio, ids[2]).status).toBe("completed");
		expect(studio.assets().find(({ id }) => id === job(studio, ids[2]).assetId)?.src).toBe(
			fixtures[0].src,
		);
	});

	test("a manual retry claims the failed parent and preserves the original", () => {
		const { studio, tick } = start();
		studio.configure({ keys: { poyo: true }, retryEnabled: true });
		const [root] = studio.submit({ ...request, outcome: "transient", options: { checker: false } });
		tick(1500);
		expect(job(studio, root).retryPending).toBe(true);
		const retry = studio.retry(root);
		expect(studio.retry(root)).toBe(retry);
		expect(job(studio, root).retryPending).toBe(false);
		tick(30000);

		expect(createdJobs(studio).map((entry) => entry.id)).toEqual([retry, root]);
		expect(job(studio, retry)).toMatchObject({
			rootId: root,
			parentId: root,
			attempt: 2,
			status: "completed",
			options: { checker: false },
		});
		expect(job(studio, root).status).toBe("failed");
	});

	test("a rate-limited batch waits for its provider without consuming a new attempt", () => {
		const { studio, reopen, tick } = start();
		studio.configure({ keys: { poyo: true, toapis: true }, retryEnabled: true });
		const delayed = studio.submit({ ...request, outcome: "rate-limit", count: 2 });
		const [following] = studio.submit(request);
		const [other] = studio.submit({ ...request, provider: "toapis" });
		tick(100);

		const eligible = job(studio, delayed[0]).nextEligibleAt;
		expect(eligible).toBeGreaterThan(timestamp + 60100);
		expect([...delayed, following].map((id) => job(studio, id).status)).toEqual([
			"queued",
			"queued",
			"queued",
		]);
		expect(job(studio, following).nextEligibleAt).toBe(eligible);
		expect(job(studio, other).status).toBe("running");

		const restored = reopen();
		expect(job(restored.studio, delayed[0]).nextEligibleAt).toBe(eligible);
		restored.tick(1500);
		expect(job(restored.studio, delayed[0]).status).toBe("queued");
		restored.tick(10000);
		expect([...delayed, following].map((id) => job(restored.studio, id).status)).toEqual([
			"completed",
			"completed",
			"completed",
		]);
		expect(createdJobs(restored.studio).length).toBe(4);
		expect(job(restored.studio, delayed[0]).attempt).toBe(1);
	});

	test("stopping a queued request is durable and stopping an active chain revokes auto-retry", () => {
		const { studio, storage, tick } = start();
		studio.configure({ keys: { poyo: true }, retryEnabled: true });
		const [active, , pending] = studio.submit({ ...request, count: 3, outcome: "transient" });
		tick(100);
		studio.stopQueued(pending);
		studio.stopQueued(active);
		expect(job(studio, active).status).toBe("running");
		tick(20000);
		expect(createdJobs(studio).filter((entry) => entry.rootId === active).length).toBe(1);
		expect(job(start(storage).studio, pending).status).toBe("cancelled");
	});

	test("disabling and re-enabling retries cannot restore an earlier retry authorization", () => {
		const { studio, tick } = start();
		studio.configure({ keys: { poyo: true }, retryEnabled: true, retryLimit: 2 });
		const [root] = studio.submit({ ...request, outcome: "transient" });
		tick(1500);
		expect(job(studio, root).retryPending).toBe(true);
		studio.configure({ retryEnabled: false });
		studio.configure({ retryEnabled: true });
		tick(20000);
		expect(createdJobs(studio)).toHaveLength(1);
		expect(job(studio, root)).toMatchObject({
			retryLimit: 2,
			autoRetriesRevoked: true,
			retryPending: false,
		});
	});

	test("disconnecting a provider cancels unsent work and revokes retries even after reconnecting", () => {
		const { studio, tick } = start();
		studio.configure({ keys: { poyo: true, toapis: true }, retryEnabled: true });
		const [active, , unsent] = studio.submit({ ...request, count: 3, outcome: "transient" });
		const [other] = studio.submit({ ...request, provider: "toapis" });
		tick(100);
		studio.configure({ keys: { poyo: false } });
		studio.configure({ keys: { poyo: true } });
		tick(20000);
		expect(createdJobs(studio).length).toBe(4);
		expect(job(studio, active).status).toBe("failed");
		expect(job(studio, unsent).status).toBe("cancelled");
		expect(job(studio, other).status).toBe("completed");
	});

	test("provider preferences hold booleans and balance snapshots require wallet access", () => {
		const { studio, storage } = start();
		expect(studio.settings()).toEqual({
			onboarded: false,
			keys: { poyo: false, toapis: false },
			wallet: { poyo: false, toapis: false },
			retryEnabled: false,
			retryLimit: 3,
		});
		expect(() => studio.submit(request)).toThrow();
		studio.configure({ onboarded: true, keys: { toapis: true, poyo: "dummy-secret" } });
		expect(studio.settings().keys.poyo).toBe(false);
		expect(studio.balance("toapis").value).toBeNull();
		studio.configure({ keys: { poyo: true }, wallet: { toapis: true } });
		expect(studio.balance("poyo").value).toBeGreaterThan(0);
		expect(studio.balance("toapis").value).toBeGreaterThan(0);
		const reloaded = start(storage).studio;
		expect(reloaded.balance("toapis")).toEqual(studio.balance("toapis"));
		expect([...storage.values()].join("")).not.toContain("dummy-secret");
	});

	test("reopening preserves completed outputs, marks active attempts uncertain, and resumes queued requests", () => {
		const { studio, storage, tick } = start();
		studio.configure({ keys: { poyo: true }, retryEnabled: true });
		const [completed] = studio.submit(request);
		tick(10000);
		const running = studio.submit({ ...request, count: 3 });
		tick(100);
		const assetId = job(studio, completed).assetId;
		const restored = start(storage);

		expect(job(restored.studio, completed).assetId).toBe(assetId);
		expect(restored.studio.assets().find(({ id }) => id === assetId)?.src).toBe(fixtures[0].src);
		expect([...storage.values()].join("")).not.toContain("data:image");
		expect(running.map((id) => job(restored.studio, id).status)).toEqual([
			"uncertain",
			"uncertain",
			"queued",
		]);
		restored.tick(30000);
		expect(running.map((id) => job(restored.studio, id).status)).toEqual([
			"uncertain",
			"uncertain",
			"completed",
		]);
		expect(createdJobs(restored.studio).length).toBe(4);
	});

	test("reopening continues a previously authorized retry during backoff exactly once", () => {
		const { studio, storage, tick } = start();
		studio.configure({ keys: { poyo: true }, retryEnabled: true, retryLimit: 1 });
		const [root] = studio.submit({ ...request, outcome: "transient" });
		tick(1500);
		const restored = start(storage);
		restored.tick(20000);
		expect(createdJobs(restored.studio).map((entry) => [entry.attempt, entry.rootId])).toEqual([
			[2, root],
			[1, root],
		]);
	});

	test("Gallery imports use signature-checked local blobs and cannot become studio inputs", async () => {
		const { studio, objectUrls, tick } = start();
		const bytes = [
			new File([png], "photo.png"),
			new File([png], "mismatch.jpg", { type: "image/jpeg" }),
			new File(["<svg></svg>"], "fake.png", { type: "image/png" }),
			new File(["<svg></svg>"], "icon.svg", { type: "image/svg+xml" }),
		];
		expect(await studio.importFiles(bytes)).toEqual({ added: 1, rejected: 3 });
		const imported = studio.assets().find(({ src }) => src === "blob:test-1");
		expect(imported?.mime).toBe("image/png");
		expect(objectUrls[0].type).toBe("image/png");
		studio.configure({ keys: { poyo: true } });
		const [jobId] = studio.submit(request);
		tick(1200);
		for (const id of [imported.id, fixtures[0].id, job(studio, jobId).assetId]) {
			expect(() => studio.submit({ ...request, sourceIds: [id] })).toThrow(/source/i);
		}
		expect(createdJobs(studio)).toHaveLength(1);
	});

	test("staged media stays outside Gallery, job events, and persisted private data", async () => {
		const { studio, storage, objectUrls, requests, errors, reopen } = start();
		const name = "private-client-file.png";
		const url = "https://secret-host.test/private/path?signature=private-value";
		const initialAssets = studio.assets();
		const published = [];
		studio.subscribe((topic, detail) => published.push({ topic, detail }));
		const local = await studio.stageFile(new File([png, "private-media-bytes"], name), "image");
		const remote = studio.stageUrl(url, "video");
		expect(local).toEqual({
			id: expect.any(String),
			kind: "image",
			title: name,
			src: "blob:test-1",
			origin: "local",
		});
		expect(remote).toEqual({
			id: expect.any(String),
			kind: "video",
			title: "Remote video",
			src: null,
			origin: "remote",
		});
		expect(local.id).not.toBe(remote.id);
		expect(objectUrls.map((blob) => blob.type)).toEqual(["image/png"]);
		expect(published).toEqual([]);
		expect(studio.assets()).toEqual(initialAssets);
		expect(storage.size).toBe(0);
		studio.configure({ keys: { poyo: true } });
		const [id] = studio.submit({ ...request, sourceIds: [local.id, remote.id] });
		const sources = [
			{ id: local.id, kind: "image", title: "Local image", origin: "local", available: true },
			{ id: remote.id, kind: "video", title: "Remote video", origin: "remote", available: true },
		];
		expect(job(studio, id)).toMatchObject({ sources, sourceUnavailable: false });
		const restored = reopen();
		expect(job(restored.studio, id)).toMatchObject({
			status: "failed",
			sourceIds: [local.id, remote.id],
			sources: sources.map((source) => ({ ...source, available: false })),
			sourceUnavailable: true,
		});
		restored.tick(30000);
		expect(() => restored.studio.retry(id)).toThrow(/source/i);
		expect(createdJobs(restored.studio)).toHaveLength(1);
		expect(requests).toEqual([]);
		expect(errors).toEqual([]);
		const recorded = JSON.stringify([studio.jobs(), published, [...storage.values()]]);
		for (const privateValue of [
			name,
			url,
			"secret-host",
			"private-value",
			"private-media-bytes",
			local.src,
		]) {
			expect(recorded).not.toContain(privateValue);
		}
	});

	test("staging rejects invalid URLs, credentials, and unsupported media kinds without I/O", () => {
		const { studio, requests, storage } = start();
		for (const url of [
			null,
			"",
			"/path",
			"file:///tmp/still.png",
			"data:image/png;base64,a",
			"javascript:alert(0)",
			"https:/example.test",
			"https:///example.test",
			"https://",
			"https://example.test:65536/",
			"https://pa%73s:secret@example.test/photo",
			"https://@example.test/photo",
			"https://example.test\\@other.test/photo",
			"https://example.test/a b",
			"https://exa\tmple.test/photo",
		]) {
			expect(() => studio.stageUrl(url, "image")).toThrow(/HTTP/);
		}
		expect(() => studio.stageUrl("http://example.test", "audio")).toThrow(/kind/i);
		expect(studio.stageUrl(" http://example.test/photo?sig=a%2Fb%3D ", "image").src).toBeNull();
		expect(requests).toEqual([]);
		expect(storage.size).toBe(0);
	});

	test("local staging checks signatures and kind, including MP4, WebM, and QuickTime MOV", async () => {
		const { studio, objectUrls } = start();
		await expect(studio.stageFile({}, "image")).rejects.toThrow(/file/i);
		await expect(studio.stageFile(new File([png], "still.png"), "audio")).rejects.toThrow(/kind/i);
		for (const [bytes, mime, kind] of [
			[png, "image/jpeg", "image"],
			[png, "image/png", "video"],
			["<svg/>", "image/svg+xml", "image"],
			["plain text", "video/quicktime", "video"],
		]) {
			await expect(
				studio.stageFile(new File([bytes], "private", { type: mime }), kind),
			).rejects.toThrow();
		}
		expect(objectUrls).toEqual([]);
		const mp4 = [Uint8Array.of(0, 0, 0, 16), "ftypisom", Uint8Array.of(0, 0, 0, 0)];
		const mov = [Uint8Array.of(0, 0, 0, 16), "ftypqt  ", Uint8Array.of(0, 0, 0, 0)];
		const webm = [Uint8Array.of(0x1a, 0x45, 0xdf, 0xa3, 0x87, 0x42, 0x82, 0x84), "webm"];
		const disguised = new File(webm, "clip.mp4", { type: "application/octet-stream" });
		await expect(studio.stageFile(disguised, "video", ["video/mp4"])).rejects.toThrow();
		expect(objectUrls).toEqual([]);
		for (const [bytes, extension, mime] of [
			[mp4, "mp4", "video/mp4"],
			[webm, "webm", "video/webm"],
			[mov, "mov", "video/quicktime"],
		]) {
			const file = new File(bytes, `clip.${extension}`, { type: "application/octet-stream" });
			expect(await studio.stageFile(file, "video")).toMatchObject({
				origin: "local",
				kind: "video",
			});
			expect(objectUrls.at(-1).type).toBe(mime);
		}
	});

	test("unstaging releases unused local previews and keeps inputs for existing queued jobs", async () => {
		const { studio, tick, revokedUrls } = start();
		const file = new File([png], "still.png");
		const unused = await studio.stageFile(file, "image");
		studio.unstageSource(unused.id);
		studio.unstageSource(unused.id);
		expect(revokedUrls).toEqual([unused.src]);
		const source = await studio.stageFile(file, "image");
		studio.configure({ keys: { poyo: true } });
		const ids = studio.submit({ ...request, sourceIds: [source.id], count: 3 });
		studio.unstageSource(source.id);
		expect(() => studio.submit({ ...request, sourceIds: [source.id] })).toThrow(/source/i);
		expect(() => studio.submit({ ...request, sourceIds: Array(1) })).toThrow(/source/i);
		tick(1200);
		expect(ids.map((id) => job(studio, id).status)).toEqual(["completed", "completed", "queued"]);
		expect(revokedUrls).toEqual([unused.src]);
		tick(10000);
		expect(ids.map((id) => job(studio, id).status)).toEqual([
			"completed",
			"completed",
			"completed",
		]);
		expect(revokedUrls).toEqual([unused.src, source.src]);
	});

	test("an unstaged input stays available through automatic and manual retries", async () => {
		const { studio, tick, revokedUrls } = start();
		studio.configure({ keys: { poyo: true }, retryEnabled: true, retryLimit: 1 });
		const source = await studio.stageFile(new File([png], "still.png"), "image");
		const [root] = studio.submit({ ...request, outcome: "transient", sourceIds: [source.id] });
		studio.unstageSource(source.id);
		tick(1500);
		expect(job(studio, root)).toMatchObject({ retryPending: true, sourceUnavailable: false });
		tick(5000);
		const automatic = createdJobs(studio).find((entry) => entry.parentId === root);
		expect(automatic).toMatchObject({ status: "failed", sourceUnavailable: false });
		expect(revokedUrls).toEqual([]);
		const manual = studio.retry(automatic.id);
		tick(1200);
		expect(job(studio, manual)).toMatchObject({ status: "completed", sourceIds: [source.id] });
		expect(revokedUrls).toEqual([source.src]);
	});

	test("cancellation releases inputs, and recovering a download only needs the existing output", async () => {
		const { studio, tick, revokedUrls, reopen } = start();
		studio.configure({ keys: { poyo: true } });
		const file = new File([png], "still.png");
		const cancelled = await studio.stageFile(file, "image");
		const [queued] = studio.submit({ ...request, sourceIds: [cancelled.id] });
		studio.unstageSource(cancelled.id);
		studio.stopQueued(queued);
		expect(revokedUrls).toEqual([cancelled.src]);

		const downloaded = await studio.stageFile(file, "image");
		const [id] = studio.submit({ ...request, outcome: "download", sourceIds: [downloaded.id] });
		studio.unstageSource(downloaded.id);
		tick(1200);
		expect(job(studio, id).status).toBe("download-failed");
		expect(revokedUrls).toEqual([cancelled.src, downloaded.src]);
		const restored = reopen();
		restored.studio.recoverDownload(id);
		expect(job(restored.studio, id).status).toBe("completed");
		expect(restored.studio.assets().find((asset) => asset.id === `output-${id}`).src).toBe(
			fixtures[0].src,
		);
	});

	test("reopening prevents pending retries and preserves uncertain sourced attempts", () => {
		const { studio, tick, reopen } = start();
		studio.configure({ keys: { poyo: true }, retryEnabled: true, retryLimit: 1 });
		const source = studio.stageUrl("https://example.test/media", "image");
		const [failed] = studio.submit({ ...request, sourceIds: [source.id], outcome: "transient" });
		tick(1200);
		const [running] = studio.submit({ ...request, sourceIds: [source.id] });
		tick(100);
		expect(job(studio, failed).retryPending).toBe(true);
		expect(job(studio, running).status).toBe("running");
		const restored = reopen();
		restored.tick(30000);
		expect(job(restored.studio, failed)).toMatchObject({
			status: "failed",
			retryPending: false,
			sourceUnavailable: true,
		});
		expect(job(restored.studio, running)).toMatchObject({
			status: "uncertain",
			sourceUnavailable: true,
		});
		expect(() => restored.studio.retry(failed)).toThrow(/source/i);
		expect(() => restored.studio.retry(running)).toThrow(/source/i);
		expect(createdJobs(restored.studio)).toHaveLength(2);
	});

	test("legacy Gallery sources stay visible in history without authorizing another submission", () => {
		const { studio, storage, tick, reopen } = start();
		studio.configure({ keys: { poyo: true }, retryEnabled: true, retryLimit: 1 });
		const [completed] = studio.submit(request);
		const [failed] = studio.submit({ ...request, outcome: "transient" });
		tick(1200);
		const [queued, missing] = studio.submit({ ...request, count: 2 });
		const key = "siluet.workspace.v1";
		const saved = JSON.parse(storage.get(key));
		for (const row of saved.jobs) {
			if ([completed, failed, queued].includes(row.id)) {
				row.sourceIds = [fixtures[0].id];
				delete row.sources;
			}
			if (row.id === missing) {
				row.sourceUnavailable = true;
				delete row.sources;
			}
		}
		storage.set(key, JSON.stringify(saved));
		const restored = reopen();
		restored.tick(30000);
		expect(job(restored.studio, queued)).toMatchObject({
			status: "failed",
			sourceUnavailable: true,
		});
		expect(job(restored.studio, failed)).toMatchObject({ status: "failed", retryPending: false });
		expect(job(restored.studio, completed)).toMatchObject({
			status: "completed",
			sources: [
				{ id: fixtures[0].id, kind: null, title: "Source", origin: null, available: false },
			],
		});
		expect(job(restored.studio, missing)).toMatchObject({
			status: "failed",
			sources: [{ id: null, title: "Source", available: false }],
		});
		expect(
			restored.studio.assets().find((asset) => asset.id === `output-${completed}`),
		).toMatchObject({
			sourceIds: [fixtures[0].id],
			src: fixtures[0].src,
		});
		expect(() => restored.studio.retry(failed)).toThrow(/source/i);
		expect(() => restored.studio.retry(missing)).toThrow(/source/i);
		expect(createdJobs(restored.studio)).toHaveLength(4);
		const reopened = restored.reopen();
		expect(job(reopened.studio, missing)).toMatchObject({
			sources: [{ id: null, title: "Source", available: false }],
			sourceUnavailable: true,
		});
		expect(() => reopened.studio.retry(missing)).toThrow(/source/i);
	});

	test("imports GIF and AVIF images offered by the gallery picker", async () => {
		const { studio, objectUrls } = start();
		const avif = new File(
			[Uint8Array.of(0, 0, 0, 20), "ftypmif1", Uint8Array.of(0, 0, 0, 0), "avif"],
			"frame.avif",
			{ type: "image/avif" },
		);
		const gif = new File(["GIF89a", Uint8Array.of(1, 0, 1, 0, 0, 0, 0)], "still.gif");
		expect(await studio.importFiles([gif, avif])).toEqual({ added: 2, rejected: 0 });
		expect(objectUrls.map((file) => file.type)).toEqual(["image/gif", "image/avif"]);
	});

	test("initial history references existing fixtures without adding duplicate assets", () => {
		const { studio } = start();
		const assets = studio.assets();
		expect(assets.map((asset) => asset.id)).toEqual(fixtures.map((asset) => asset.id));
		for (const job of studio.jobs().filter((entry) => entry.status === "completed")) {
			expect(assets.find((asset) => asset.id === job.assetId)?.kind).toBe(job.kind);
		}
	});

	test("view handoffs carry an asset ID only once and observers can unsubscribe", () => {
		const { studio, views, routes } = start();
		const topics = [];
		const unsubscribe = studio.subscribe((topic) => topics.push(topic));
		studio.configure({ keys: { poyo: true } });
		unsubscribe();
		studio.configure({ keys: { toapis: true } });
		expect(topics).toEqual(["settings"]);
		expect(views).toEqual({});
		studio.openAsset(fixtures[0].id);
		expect(studio.consumeAsset()).toBe(fixtures[0].id);
		expect(studio.consumeAsset()).toBeNull();
		expect(studio.useSource).toBeUndefined();
		expect(studio.consumeSource).toBeUndefined();
		expect(routes).toEqual(["gallery"]);
	});
});
