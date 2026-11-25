import { afterAll, afterEach, expect, test } from "bun:test";
import { setSessionClient } from "#lib/shared/owner/session-client.ts";
import { downloadPrivate, privateSource, readPrivate } from "./private-media";

// The tab's media limits ([browser key sessions](../../../../docs/SPEC-browser-key.md#media)):
// four reads at a time and 192 MiB held, against a fake studio whose answers the test releases.
const MiB = 1024 * 1024;
const bytes = new Uint8Array(64 * MiB);
let session: string | null = "s1";
let remountKey = 0;
setSessionClient({
	bound: () => (session ? { sessionId: session, loginId: "l" } : null),
	get remountKey() {
		return remountKey;
	},
} as never);
let clicks = 0;

type Call = { src: string; init: RequestInit & { siluetSession?: string }; answer: () => void };
let calls: Call[] = [];
/** Each fetch waits for its `answer()`, then declares its size and streams once its body is released. */
const sizes = new Map<string, number>();
const bodies = new Map<string, () => void>();
/** Sources whose answer declares no length. */
const undeclared = new Set<string>();
// Bun shares globals across test files; the originals come back after this one.
const originals = { fetch: globalThis.fetch, document: globalThis.document };
const observer = "IntersectionObserver" in globalThis;
afterAll(() => {
	Object.assign(globalThis, originals);
	if (!observer) Reflect.deleteProperty(globalThis, "IntersectionObserver");
});
globalThis.fetch = ((input: RequestInfo | URL, init: Call["init"] = {}) => {
	const src = String(input);
	const { promise, resolve } = Promise.withResolvers<void>();
	calls.push({ src, init, answer: resolve });
	return promise.then(() => {
		init.signal?.throwIfAborted();
		const size = sizes.get(src) ?? 1;
		const streamed = Promise.withResolvers<void>();
		bodies.set(src, streamed.resolve);
		if (!sizes.has(src)) streamed.resolve();
		const body = new ReadableStream<Uint8Array>({
			async pull(controller) {
				await streamed.promise;
				controller.enqueue(bytes.subarray(0, size));
				controller.close();
			},
		});
		const headers: Record<string, string> = undeclared.has(src)
			? {}
			: { "content-length": String(size) };
		return new Response(body, { headers });
	});
}) as typeof fetch;
Object.assign(globalThis, {
	IntersectionObserver: class {
		observe() {}
		disconnect() {}
	},
	document: {
		createElement: () => ({
			click() {
				clicks++;
			},
			remove() {},
		}),
		body: { append() {} },
	},
});

const tick = () => Bun.sleep(1);
/** Show `src` in a fake element; resolves once its blob is attached or the element is cleared. */
function show(src: string) {
	const element = {
		src: "",
		removeAttribute() {
			element.src = "";
		},
	};
	const cleanup = privateSource(src, "video/mp4", "video")(element as never) as () => void;
	cleanups.push(cleanup);
	return element;
}
let cleanups: (() => void)[] = [];
afterEach(async () => {
	for (const call of calls) call.answer();
	for (const body of bodies.values()) body();
	await tick();
	for (const cleanup of cleanups) cleanup();
	cleanups = [];
	calls = [];
	sizes.clear();
	bodies.clear();
	undeclared.clear();
	session = "s1";
	remountKey = 0;
	clicks = 0;
});

test("an aborted waiter leaves the queue at once and the next waiter gets the freed read", async () => {
	const first = Array.from({ length: 4 }, (_, i) =>
		readPrivate(`/a${i}`, "image/png", "image", new AbortController().signal),
	);
	await tick();
	expect(calls).toHaveLength(4);
	const stopped = new AbortController();
	const aborted = readPrivate("/aborted", "image/png", "image", stopped.signal);
	const next = readPrivate("/next", "image/png", "image", new AbortController().signal);
	stopped.abort();
	await expect(aborted).rejects.toMatchObject({ name: "AbortError" });
	calls[0].answer();
	await first[0];
	await tick();
	expect(calls.map((call) => call.src)).toEqual(["/a0", "/a1", "/a2", "/a3", "/next"]);
	for (const call of calls) call.answer();
	await Promise.all([...first, next]);
});

test("a queued read keeps the session it was asked under, even if the tab moves on", async () => {
	const first = Array.from({ length: 4 }, (_, i) =>
		readPrivate(`/b${i}`, "image/png", "image", new AbortController().signal),
	);
	const queued = readPrivate("/queued", "image/png", "image", new AbortController().signal);
	await tick();
	session = "s2";
	calls[0].answer();
	await first[0];
	await tick();
	expect(calls.at(-1)).toMatchObject({ src: "/queued", init: { siluetSession: "s1" } });
	for (const call of calls) call.answer();
	await Promise.all([...first, queued]);
});

/** Answer `src`'s request, then stream its body. */
async function deliver(src: string) {
	calls.find((call) => call.src === src)?.answer();
	await tick();
	bodies.get(src)?.();
	await tick();
}

test("reads in flight count against the tab's 192 MiB, evicting the least recently visible file", async () => {
	for (const src of ["/v1", "/v2", "/v3", "/v4"]) sizes.set(src, 64 * MiB);
	const v1 = show("/v1");
	const v2 = show("/v2");
	await tick();
	await deliver("/v1");
	await deliver("/v2");
	expect([v1.src, v2.src].every(Boolean)).toBe(true);
	// Two more declare 64 MiB each; until their bodies arrive the tab already holds 256 MiB.
	show("/v3");
	show("/v4");
	await tick();
	for (const src of ["/v3", "/v4"]) calls.find((call) => call.src === src)?.answer();
	await tick();
	expect(v1.src).toBe("");
	expect(v2.src).not.toBe("");
});

test("a download's blob counts until its link is revoked", async () => {
	const revoke: (() => void)[] = [];
	const realTimeout = globalThis.setTimeout;
	globalThis.setTimeout = ((callback: () => void) => revoke.push(callback)) as never;
	try {
		sizes.set("/download", 64 * MiB);
		const download = downloadPrivate("/download", "video/mp4", "video", "clip.mp4");
		await tick();
		await deliver("/download");
		await download;
	} finally {
		globalThis.setTimeout = realTimeout;
	}
	const showAll = async (sources: string[]) => {
		const shown = sources.map((src) => show(src));
		await tick();
		for (const src of sources) await deliver(src);
		return shown;
	};
	for (const src of ["/w1", "/w2", "/w3", "/x1", "/x2", "/x3"]) sizes.set(src, 64 * MiB);
	// 64 MiB still downloading plus three shown files: the first shown one gives way.
	const shown = await showAll(["/w1", "/w2", "/w3"]);
	expect(shown.map((element) => element.src !== "")).toEqual([false, true, true]);
	for (const cleanup of cleanups.splice(0)) cleanup();
	// Once the link is revoked, three files fit.
	expect(revoke).toHaveLength(1);
	revoke[0]();
	const after = await showAll(["/x1", "/x2", "/x3"]);
	expect(after.map((element) => element.src !== "")).toEqual([true, true, true]);
});

test("downloads past the tab's 192 MiB wait for an earlier link to be revoked", async () => {
	const revoke: (() => void)[] = [];
	const realTimeout = globalThis.setTimeout;
	globalThis.setTimeout = ((callback: () => void) => revoke.push(callback)) as never;
	try {
		for (const src of ["/d1", "/d2", "/d3", "/d4"]) sizes.set(src, 64 * MiB);
		for (const src of ["/d1", "/d2", "/d3"]) {
			const download = downloadPrivate(src, "video/mp4", "video", "clip.mp4");
			await tick();
			await deliver(src);
			await download;
		}
		const fourth = downloadPrivate("/d4", "video/mp4", "video", "clip.mp4");
		await tick();
		calls.find((call) => call.src === "/d4")?.answer();
		await tick();
		// Three links hold 192 MiB: the fourth read is answered but does not buffer its body.
		expect(revoke).toHaveLength(3);
		let finished = false;
		void fourth.then(() => {
			finished = true;
		});
		bodies.get("/d4")?.();
		await tick();
		expect(finished).toBe(false);
		revoke[0]();
		await tick();
		bodies.get("/d4")?.();
		await fourth;
		expect(revoke).toHaveLength(4);
		for (const link of revoke.slice(1)) link();
	} finally {
		globalThis.setTimeout = realTimeout;
	}
});

test("a read that declares no length reserves its kind's whole limit", async () => {
	for (const src of ["/u1", "/u2"]) sizes.set(src, 64 * MiB);
	const u1 = show("/u1");
	const u2 = show("/u2");
	await tick();
	await deliver("/u1");
	await deliver("/u2");
	sizes.set("/unknown", 1);
	undeclared.add("/unknown");
	show("/unknown");
	await tick();
	calls.find((call) => call.src === "/unknown")?.answer();
	await tick();
	// 128 MiB shown plus 64 MiB reserved fits; the shown files stay.
	expect([u1.src, u2.src].every(Boolean)).toBe(true);
	sizes.set("/next", 64 * MiB);
	show("/next");
	await tick();
	calls.find((call) => call.src === "/next")?.answer();
	await tick();
	// The next 64 MiB evicts the least recently visible shown file.
	expect(u1.src).toBe("");
	expect(u2.src).not.toBe("");
});

/** Run `body` with link timers captured instead of scheduled, then revoke every link. */
async function withLinks(body: (revoke: (() => void)[]) => Promise<void>) {
	const revoke: (() => void)[] = [];
	const realTimeout = globalThis.setTimeout;
	globalThis.setTimeout = ((callback: () => void) => revoke.push(callback)) as never;
	try {
		await body(revoke);
	} finally {
		globalThis.setTimeout = realTimeout;
		for (const link of revoke.splice(0)) link();
	}
}

test("a read that eviction cannot make room for waits without evicting what is shown", async () => {
	await withLinks(async () => {
		for (const src of ["/e1", "/e2"]) {
			sizes.set(src, 64 * MiB);
			const download = downloadPrivate(src, "video/mp4", "video", "clip.mp4");
			await tick();
			await deliver(src);
			await download;
		}
		sizes.set("/shown", 32 * MiB);
		const shown = show("/shown");
		await tick();
		await deliver("/shown");
		sizes.set("/streaming", 32 * MiB);
		show("/streaming");
		await tick();
		calls.find((call) => call.src === "/streaming")?.answer();
		await tick();
		// 128 MiB of links, 32 shown and 32 streaming: evicting the shown file cannot fit 64 more.
		sizes.set("/waiting", 64 * MiB);
		show("/waiting");
		await tick();
		calls.find((call) => call.src === "/waiting")?.answer();
		await tick();
		expect(shown.src).not.toBe("");
	});
});

test("a download whose session ended while it waited saves nothing, and a second click joins the first", async () => {
	await withLinks(async () => {
		sizes.set("/mine", 64 * MiB);
		const first = downloadPrivate("/mine", "video/mp4", "video", "clip.mp4");
		const second = downloadPrivate("/mine", "video/mp4", "video", "clip.mp4");
		expect(second).toBe(first);
		await tick();
		expect(calls.filter((call) => call.src === "/mine")).toHaveLength(1);
		remountKey++;
		await deliver("/mine");
		await first;
		expect(clicks).toBe(0);
	});
});
