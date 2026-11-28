import { afterAll, afterEach, expect, test } from "bun:test";
import { setSessionClient } from "#lib/shared/owner/session-client.ts";
import {
	downloadCap,
	downloadPrivate,
	type MediaKind,
	MediaUnavailable,
	mediaLimits,
	privateSource,
	readCap,
	readPrivate,
} from "./private-media";

// The tab's media limits ([browser key sessions](../../../../docs/SPEC-browser-key.md#media)):
// four reads at a time and 240 MiB held, against a fake studio whose answers the test releases.
// Images are the largest kind (80 MiB), so the cases read them; 40 MiB is half of one.
const MiB = 1024 * 1024;
const bytes = new Uint8Array(80 * MiB);
let session: string | null = "s1";
let remountKey = 0;
let leaving = false;
const listeners = new Set<() => void>();
/** Drop the tab's per-session work, as a sign-out or session change does. */
function remount() {
	remountKey++;
	for (const listener of listeners) listener();
}
setSessionClient({
	subscribe(listener: () => void) {
		listeners.add(listener);
		listener();
		return () => listeners.delete(listener);
	},
	get leaving() {
		return leaving;
	},
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
/** Sources whose answer sends these headers instead of a `Content-Length` of its size. */
const declared = new Map<string, Record<string, string>>();
/** Sources whose body stays open after its bytes until the reader cancels it. */
const unending = new Set<string>();
/** Sources whose body the reader cancelled. */
const cancelled = new Set<string>();
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
		let sent = false;
		const body = new ReadableStream<Uint8Array>({
			async pull(controller) {
				if (sent) return new Promise<void>(() => {});
				await streamed.promise;
				sent = true;
				controller.enqueue(size > bytes.length ? new Uint8Array(size) : bytes.subarray(0, size));
				if (!unending.has(src)) controller.close();
			},
			cancel() {
				cancelled.add(src);
			},
		});
		const headers: Record<string, string> =
			declared.get(src) ?? (undeclared.has(src) ? {} : { "content-length": String(size) });
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
	const cleanup = privateSource(src, "image/png", "image")(element as never) as () => void;
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
	declared.clear();
	unending.clear();
	cancelled.clear();
	session = "s1";
	remountKey = 0;
	leaving = false;
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

/** Answer every request, including those the answers let start. */
async function drain() {
	for (let i = 0; i < 8; i++) {
		for (const call of calls) call.answer();
		await tick();
	}
}

/** Answer `src`'s request, then stream its body. */
async function deliver(src: string) {
	calls.find((call) => call.src === src)?.answer();
	await tick();
	bodies.get(src)?.();
	await tick();
}

test("the per-tab cap is 240 MiB, at least twice the largest kind, and downloads pin at most 160 MiB", () => {
	const largest = Math.max(...Object.values(mediaLimits));
	expect(largest).toBe(mediaLimits.image);
	expect(readCap).toBe(240 * MiB);
	expect(readCap).toBeGreaterThanOrEqual(2 * largest);
	expect(downloadCap).toBe(readCap - largest);
	expect(downloadCap).toBe(160 * MiB);
});

test("reads in flight count against the tab's 240 MiB, evicting the least recently visible file", async () => {
	for (const src of ["/v1", "/v2", "/v3", "/v4"]) sizes.set(src, 80 * MiB);
	const v1 = show("/v1");
	const v2 = show("/v2");
	await tick();
	await deliver("/v1");
	await deliver("/v2");
	expect([v1.src, v2.src].every(Boolean)).toBe(true);
	// Two more declare 80 MiB each; until their bodies arrive the tab already holds 320 MiB.
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
		sizes.set("/download", 80 * MiB);
		const download = downloadPrivate("/download", "image/png", "image", "a.png");
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
	for (const src of ["/w1", "/w2", "/w3", "/x1", "/x2", "/x3"]) sizes.set(src, 80 * MiB);
	// 80 MiB still linked plus three shown files: the first shown one gives way.
	const shown = await showAll(["/w1", "/w2", "/w3"]);
	expect(shown.map((element) => element.src !== "")).toEqual([false, true, true]);
	for (const cleanup of cleanups.splice(0)) cleanup();
	// Once the link is revoked, three files fit.
	expect(revoke).toHaveLength(1);
	revoke[0]();
	const after = await showAll(["/x1", "/x2", "/x3"]);
	expect(after.map((element) => element.src !== "")).toEqual([true, true, true]);
});

test("downloads past their 160 MiB share wait for an earlier link to be revoked", async () => {
	const revoke: (() => void)[] = [];
	const realTimeout = globalThis.setTimeout;
	globalThis.setTimeout = ((callback: () => void) => revoke.push(callback)) as never;
	try {
		for (const src of ["/d1", "/d2", "/d3"]) sizes.set(src, 80 * MiB);
		for (const src of ["/d1", "/d2"]) {
			const download = downloadPrivate(src, "image/png", "image", "a.png");
			await tick();
			await deliver(src);
			await download;
		}
		// Two links hold 160 MiB, leaving 80 MiB for a shown image: the third download sends
		// nothing and evicts nothing while it waits.
		const shown = show("/kept");
		await tick();
		await deliver("/kept");
		const third = downloadPrivate("/d3", "image/png", "image", "a.png");
		await tick();
		expect(revoke).toHaveLength(2);
		expect(calls.some((call) => call.src === "/d3")).toBe(false);
		expect(shown.src).not.toBe("");
		revoke[0]();
		await tick();
		await deliver("/d3");
		await third;
		expect(revoke).toHaveLength(3);
		for (const link of revoke.slice(1)) link();
	} finally {
		globalThis.setTimeout = realTimeout;
	}
});

test("one shown 80 MiB image and two 80 MiB downloads proceed, and a third waits within the cap", async () => {
	await withLinks(async (revoke) => {
		for (const src of ["/shown80", "/dl1", "/dl2", "/dl3"]) sizes.set(src, 80 * MiB);
		const shown = show("/shown80");
		await tick();
		await deliver("/shown80");
		const downloads = ["/dl1", "/dl2", "/dl3"].map((src) =>
			downloadPrivate(src, "image/png", "image", "a.png"),
		);
		await tick();
		expect(calls.map((call) => call.src)).toEqual(["/shown80", "/dl1", "/dl2"]);
		for (const src of ["/dl1", "/dl2"]) await deliver(src);
		await Promise.all(downloads.slice(0, 2));
		// 80 MiB shown and 160 MiB linked fill the 240 MiB cap; the third download sends nothing.
		expect(shown.src).not.toBe("");
		expect(clicks).toBe(2);
		expect(calls.some((call) => call.src === "/dl3")).toBe(false);
		revoke[0]();
		await tick();
		await deliver("/dl3");
		await downloads[2];
		expect([clicks, shown.src !== ""]).toEqual([3, true]);
	});
});

test("a read that declares no length reserves its kind's whole limit", async () => {
	for (const src of ["/u1", "/u2"]) sizes.set(src, 80 * MiB);
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
	// 160 MiB shown plus 80 MiB reserved fits; the shown files stay.
	expect([u1.src, u2.src].every(Boolean)).toBe(true);
	sizes.set("/next", 80 * MiB);
	show("/next");
	await tick();
	calls.find((call) => call.src === "/next")?.answer();
	await tick();
	// The next 80 MiB evicts the least recently visible shown file.
	expect(u1.src).toBe("");
	expect(u2.src).not.toBe("");
});

// The Gallery's image GET streams its body, and Bun then drops a set `Content-Length`; it
// declares the verified length as `X-Siluet-Length` instead, which the tab prefers.
const siluet = (length: number | string, extra: Record<string, string> = {}) => ({
	"x-siluet-length": String(length),
	...extra,
});

test("twelve 2 MiB tiles declared only by X-Siluet-Length all stay shown", async () => {
	const tiles = Array.from({ length: 12 }, (_, i) => {
		const src = `/tile${i}`;
		sizes.set(src, 2 * MiB);
		declared.set(src, siluet(2 * MiB));
		return show(src);
	});
	// Answer every request before its body streams, so four reads are in flight at once.
	for (let round = 0; round < 6; round++) {
		for (const call of calls) call.answer();
		await tick();
		for (const body of bodies.values()) body();
		await tick();
	}
	expect(calls).toHaveLength(12);
	expect(tiles.filter((tile) => tile.src !== "")).toHaveLength(12);
});

test.each([
	["longer", 40 * MiB + 1],
	["shorter", 40 * MiB - 1],
])("a body %s than its X-Siluet-Length fails and releases its reservation", async (_, size) => {
	sizes.set("/mismatch", size);
	declared.set("/mismatch", siluet(40 * MiB));
	// A longer body is cancelled at its first extra byte; a shorter one fails when it ends.
	if (size > 40 * MiB) unending.add("/mismatch");
	const read = readPrivate("/mismatch", "image/png", "image", new AbortController().signal);
	const failure = read.catch((error: unknown) => error);
	await tick();
	await deliver("/mismatch");
	expect(await failure).toBeInstanceOf(TypeError);
	expect(cancelled.has("/mismatch")).toBe(size > 40 * MiB);
	// A leaked 40 MiB would leave no room for three 80 MiB files.
	const shown = ["/r1", "/r2", "/r3"].map((src) => {
		sizes.set(src, 80 * MiB);
		return show(src);
	});
	await tick();
	for (const src of ["/r1", "/r2", "/r3"]) await deliver(src);
	expect(shown.every((element) => element.src !== "")).toBe(true);
});

test("an X-Siluet-Length over the kind's limit is unavailable and cancels the body", async () => {
	sizes.set("/huge", 1);
	declared.set("/huge", siluet(mediaLimits.image + 1, { "content-length": "1" }));
	unending.add("/huge");
	const read = readPrivate("/huge", "image/png", "image", new AbortController().signal);
	const failure = read.catch((error: unknown) => error);
	await tick();
	await deliver("/huge");
	expect(await failure).toBeInstanceOf(MediaUnavailable);
	expect(cancelled.has("/huge")).toBe(true);
});

/**
 * Show two 80 MiB files, answer `src` with its body held, then answer a 1-byte read: it evicts
 * the older shown file only if `src` reserved 80 MiB.
 */
async function reservesWhole(src: string, headers: Record<string, string>, size: number) {
	for (const shown of ["/s1", "/s2"]) sizes.set(shown, 80 * MiB);
	const s1 = show("/s1");
	const s2 = show("/s2");
	await tick();
	await deliver("/s1");
	await deliver("/s2");
	sizes.set(src, size);
	declared.set(src, headers);
	show(src);
	await tick();
	calls.find((call) => call.src === src)?.answer();
	await tick();
	sizes.set("/byte", 1);
	declared.set("/byte", siluet(1, { "content-length": "1" }));
	show("/byte");
	await tick();
	calls.find((call) => call.src === "/byte")?.answer();
	await tick();
	expect(s2.src).not.toBe("");
	return s1.src === "";
}

test.each(["", "2 MiB", "-1", "1.5", "0x10"])(
	"a malformed X-Siluet-Length %p reserves the kind's limit, never the Content-Length",
	async (value) => {
		expect(await reservesWhole("/malformed", siluet(value, { "content-length": "1" }), 1)).toBe(
			true,
		);
	},
);

test("with both headers, X-Siluet-Length decides the reservation", async () => {
	expect(await reservesWhole("/both", siluet(80 * MiB, { "content-length": "1" }), 80 * MiB)).toBe(
		true,
	);
});

test("a download's share shrinks to its X-Siluet-Length", async () => {
	await withLinks(async () => {
		sizes.set("/small", 2 * MiB);
		declared.set("/small", siluet(2 * MiB));
		sizes.set("/large", 78 * MiB);
		sizes.set("/third", 80 * MiB);
		const downloads = ["/small", "/large", "/third"].map((src) =>
			downloadPrivate(src, "image/png", "image", "a.png"),
		);
		await tick();
		calls.find((call) => call.src === "/large")?.answer();
		await tick();
		// 80 MiB reserved for the undeclared small one and 78 MiB leave no room for the third.
		expect(calls.map((call) => call.src)).toEqual(["/small", "/large"]);
		calls.find((call) => call.src === "/small")?.answer();
		await tick();
		expect(calls.map((call) => call.src)).toEqual(["/small", "/large", "/third"]);
		for (const src of ["/small", "/large", "/third"]) await deliver(src);
		await Promise.all(downloads);
	});
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
			sizes.set(src, 80 * MiB);
			const download = downloadPrivate(src, "image/png", "image", "a.png");
			await tick();
			await deliver(src);
			await download;
		}
		sizes.set("/shown", 40 * MiB);
		const shown = show("/shown");
		await tick();
		await deliver("/shown");
		sizes.set("/streaming", 40 * MiB);
		show("/streaming");
		await tick();
		calls.find((call) => call.src === "/streaming")?.answer();
		await tick();
		// 160 MiB of links, 40 shown and 40 streaming: evicting the shown file cannot fit 80 more.
		sizes.set("/waiting", 80 * MiB);
		show("/waiting");
		await tick();
		calls.find((call) => call.src === "/waiting")?.answer();
		await tick();
		expect(shown.src).not.toBe("");
	});
});

test("a download whose session ended while it waited saves nothing, and a second click joins the first", async () => {
	await withLinks(async () => {
		sizes.set("/mine", 80 * MiB);
		const first = downloadPrivate("/mine", "image/png", "image", "a.png");
		const second = downloadPrivate("/mine", "image/png", "image", "a.png");
		expect(second).toBe(first);
		await tick();
		expect(calls.filter((call) => call.src === "/mine")).toHaveLength(1);
		remount();
		await deliver("/mine");
		await first;
		expect(clicks).toBe(0);
	});
});

test("eviction skips a shown file a download link still holds, which would free nothing", async () => {
	await withLinks(async () => {
		sizes.set("/p1", 80 * MiB);
		sizes.set("/p2", 80 * MiB);
		sizes.set("/p3", 40 * MiB);
		const p1 = show("/p1");
		await tick();
		await deliver("/p1");
		const p2 = show("/p2");
		await tick();
		await deliver("/p2");
		const p3 = show("/p3");
		await tick();
		await deliver("/p3");
		// The oldest shown file is also being downloaded.
		await downloadPrivate("/p1", "image/png", "image", "a.png");
		sizes.set("/n", 80 * MiB);
		show("/n");
		await tick();
		calls.find((call) => call.src === "/n")?.answer();
		await tick();
		expect([p1.src !== "", p2.src !== "", p3.src !== ""]).toEqual([true, false, true]);
	});
});

test("a click after a remount starts its own download instead of joining the old one", async () => {
	await withLinks(async () => {
		const old = downloadPrivate("/again", "image/png", "image", "a.png");
		await tick();
		remount();
		const fresh = downloadPrivate("/again", "image/png", "image", "a.png");
		expect(fresh).not.toBe(old);
		await tick();
		expect(calls.filter((call) => call.src === "/again")).toHaveLength(2);
		for (const call of calls) call.answer();
		await Promise.all([old, fresh]);
		expect(clicks).toBe(1);
	});
});

test("a download that finishes while the tab is leaving saves nothing", async () => {
	await withLinks(async () => {
		sizes.set("/late", 1);
		const download = downloadPrivate("/late", "image/png", "image", "a.png");
		await tick();
		leaving = true;
		await deliver("/late");
		await download;
		expect(clicks).toBe(0);
	});
});

// Shown files keep priority over a second download, but a download never starves behind them.
test("while a download reads, a shown file waiting for a read goes ahead of a further download", async () => {
	await withLinks(async () => {
		const reading = downloadPrivate("/reading", "image/png", "image", "a.png");
		await tick();
		const first = Array.from({ length: 3 }, (_, i) =>
			readPrivate(`/q${i}`, "image/png", "image", new AbortController().signal),
		);
		await tick();
		const download = downloadPrivate("/later", "image/png", "image", "a.png");
		await tick();
		show("/tile");
		await tick();
		calls[1].answer();
		await first[0];
		await tick();
		expect(calls.map((call) => call.src).slice(4)).toEqual(["/tile"]);
		calls[2].answer();
		await first[1];
		await tick();
		expect(calls.map((call) => call.src).slice(4)).toEqual(["/tile", "/later"]);
		for (const call of calls) call.answer();
		await Promise.all([...first, reading, download]);
	});
});

test("with no download reading, the oldest waiting download takes the next free read", async () => {
	await withLinks(async () => {
		let n = 0;
		const shown: Promise<Blob>[] = [];
		const read = () => {
			const read = readPrivate(`/r${n++}`, "image/png", "image", new AbortController().signal);
			shown.push(read);
			return read;
		};
		for (let i = 0; i < 4; i++) read();
		await tick();
		const download = downloadPrivate("/starved", "image/png", "image", "a.png");
		// The display queue never empties: another shown read waits whenever one ends.
		for (let i = 0; i < 4; i++) {
			read();
			await tick();
			calls[i].answer();
			await tick();
		}
		expect(calls.some((call) => call.src === "/starved")).toBe(true);
		await drain();
		await download;
		expect(clicks).toBe(1);
		await Promise.all(shown);
	});
});

test("downloads hold at most three of the tab's four reads, so a shown file always gets one", async () => {
	await withLinks(async () => {
		// Staged files' 32,000,000-byte limit lets four downloads' shares fit; only reads are short.
		const downloads = ["/g1", "/g2", "/g3", "/g4"].map((src) =>
			downloadPrivate(src, "image/png", "staged", "a.png"),
		);
		await tick();
		expect(calls.map((call) => call.src)).toEqual(["/g1", "/g2", "/g3"]);
		const seen = show("/seen");
		await tick();
		expect(calls.map((call) => call.src)).toEqual(["/g1", "/g2", "/g3", "/seen"]);
		await deliver("/seen");
		expect(seen.src).not.toBe("");
		// The free read stays with shown files while three downloads are still reading.
		expect(calls).toHaveLength(4);
		calls[0].answer();
		await downloads[0];
		await tick();
		expect(calls.at(-1)?.src).toBe("/g4");
		for (const call of calls) call.answer();
		await Promise.all(downloads);
	});
});

test("a shown file is linked for download only within the downloads' share", async () => {
	await withLinks(async (revoke) => {
		for (const src of ["/s1", "/s2", "/big"]) sizes.set(src, 80 * MiB);
		for (const src of ["/s1", "/s2"]) {
			const download = downloadPrivate(src, "image/png", "image", "a.png");
			await tick();
			await deliver(src);
			await download;
		}
		show("/big");
		await tick();
		await deliver("/big");
		const reads = calls.length;
		const download = downloadPrivate("/big", "image/png", "image", "a.png");
		await tick();
		expect([clicks, revoke.length]).toEqual([2, 2]);
		revoke.shift()?.();
		await download;
		// The shown blob was reused, not read again.
		expect([clicks, calls.length]).toEqual([3, reads]);
	});
});

test("a download keeps the session it was clicked under while it waits for its share", async () => {
	await withLinks(async (revoke) => {
		for (const src of ["/t1", "/t2", "/gone"]) sizes.set(src, 80 * MiB);
		for (const src of ["/t1", "/t2"]) {
			const download = downloadPrivate(src, "image/png", "image", "a.png");
			await tick();
			await deliver(src);
			await download;
		}
		show("/gone");
		await tick();
		await deliver("/gone");
		const download = downloadPrivate("/gone", "image/png", "image", "a.png");
		await tick();
		session = "s2";
		// The shown file goes before the share frees, so the download reads it once it may.
		for (const cleanup of cleanups.splice(0)) cleanup();
		await tick();
		expect(calls.filter((call) => call.src === "/gone")).toHaveLength(1);
		revoke.shift()?.();
		await tick();
		const read = calls.filter((call) => call.src === "/gone").at(-1);
		expect(calls.filter((call) => call.src === "/gone")).toHaveLength(2);
		expect(read?.init.siluetSession).toBe("s1");
		read?.answer();
		await tick();
		bodies.get("/gone")?.();
		await download;
		expect(clicks).toBe(3);
	});
});

/** Download `src` and keep its link, holding its bytes against the downloads' share. */
async function link(src: string, size: number, kind: MediaKind) {
	sizes.set(src, size);
	const download = downloadPrivate(src, "video/mp4", kind, "a");
	await tick();
	await deliver(src);
	await download;
}
/** Fill the downloads' 160 MiB share with links of these sizes and kinds, oldest first. */
async function fill(...links: [number, MediaKind][]) {
	for (const [i, [size, kind]] of links.entries()) await link(`/link${i}`, size, kind);
}
const twoImages: [number, "image"][] = [
	[80 * MiB, "image"],
	[80 * MiB, "image"],
];

test("a download waiting for its share has sent nothing and leaves every read to shown files", async () => {
	await withLinks(async () => {
		await fill(...twoImages);
		const before = calls.length;
		const waiting = downloadPrivate("/waits", "image/png", "image", "a.png");
		await tick();
		const tiles = ["/f1", "/f2", "/f3", "/f4"].map((src) => show(src));
		await tick();
		expect(calls.slice(before).map((call) => call.src)).toEqual(["/f1", "/f2", "/f3", "/f4"]);
		for (const call of calls) call.answer();
		await tick();
		expect(tiles.every((tile) => tile.src !== "")).toBe(true);
		remount();
		await waiting;
	});
});

test.each([
	["a fresh read", false],
	["a shown file", true],
])("a newer, smaller download waits behind an older one, as %s", async (_, reuse) => {
	await withLinks(async (revoke) => {
		// Each link first reserves its kind's limit, so the smallest comes first.
		await fill([16 * MiB, "staged"], [64 * MiB, "video"], [80 * MiB, "image"]);
		sizes.set("/older", 80 * MiB);
		sizes.set("/newer", 40 * MiB);
		if (reuse) {
			show("/newer");
			await tick();
			await deliver("/newer");
		}
		const before = calls.length;
		const order: string[] = [];
		const older = downloadPrivate("/older", "image/png", "image", "a").then(() =>
			order.push("older"),
		);
		// A fresh read of the newer one reserves a video's 64 MiB until it declares its length.
		const newer = downloadPrivate("/newer", "video/mp4", "video", "a").then(() =>
			order.push("newer"),
		);
		await tick();
		// 64 MiB frees: enough for the newer download, not the older one, which keeps its turn.
		revoke[1]();
		await tick();
		await deliver("/newer");
		expect(calls.slice(before)).toEqual([]);
		expect(order).toEqual([]);
		revoke[0]();
		await tick();
		await deliver("/older");
		await older;
		revoke[2]();
		await tick();
		await deliver("/newer");
		await newer;
		expect(order).toEqual(["older", "newer"]);
	});
});

test("a read that stops while waiting for room cancels the body it was answered with", async () => {
	for (const src of ["/h1", "/h2", "/h3", "/h4"]) sizes.set(src, 80 * MiB);
	const signal = () => new AbortController().signal;
	const first = ["/h1", "/h2", "/h3"].map((src) =>
		readPrivate(src, "image/png", "image", signal()),
	);
	await tick();
	for (const call of calls) call.answer();
	await tick();
	// Three reads stream 240 MiB, which nothing can evict; the fourth waits for room.
	const stopped = new AbortController();
	const fourth = readPrivate("/h4", "image/png", "image", stopped.signal);
	await tick();
	calls[3].answer();
	await tick();
	stopped.abort();
	await expect(fourth).rejects.toMatchObject({ name: "AbortError" });
	expect(cancelled.has("/h4")).toBe(true);
	for (const body of bodies.values()) body();
	await Promise.all(first);
});

test("a remount drops a waiting download at once, and it sends nothing later", async () => {
	await withLinks(async (revoke) => {
		await fill(...twoImages);
		const before = calls.length;
		let settled = false;
		const waiting = downloadPrivate("/dropped", "image/png", "image", "a.png").then(() => {
			settled = true;
		});
		await tick();
		remount();
		await tick();
		expect(settled).toBe(true);
		revoke[0]();
		await tick();
		expect(calls.slice(before)).toEqual([]);
		await waiting;
		expect(clicks).toBe(2);
	});
});

test("a download waiting while the tab leaves sends nothing once its share frees", async () => {
	await withLinks(async (revoke) => {
		await fill(...twoImages);
		const before = calls.length;
		const waiting = downloadPrivate("/left", "image/png", "image", "a.png");
		await tick();
		leaving = true;
		revoke[0]();
		await waiting;
		expect(calls.slice(before)).toEqual([]);
		expect(clicks).toBe(2);
	});
});

test("a download of a shown file that the tab drops while it waits sends nothing", async () => {
	await withLinks(async (revoke) => {
		await fill(...twoImages);
		sizes.set("/kept", 40 * MiB);
		show("/kept");
		await tick();
		await deliver("/kept");
		const before = calls.length;
		let settled = false;
		const waiting = downloadPrivate("/kept", "image/png", "image", "a.png").then(() => {
			settled = true;
		});
		await tick();
		remount();
		await tick();
		expect(settled).toBe(true);
		revoke[0]();
		await waiting;
		expect([calls.length - before, clicks]).toEqual([0, 2]);
	});
});
