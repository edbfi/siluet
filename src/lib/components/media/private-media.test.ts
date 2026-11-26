import { afterAll, afterEach, expect, test } from "bun:test";
import { setSessionClient } from "#lib/shared/owner/session-client.ts";
import { downloadPrivate, privateSource, readPrivate } from "./private-media";

// The tab's media limits ([browser key sessions](../../../../docs/SPEC-browser-key.md#media)):
// four reads at a time and 192 MiB held, against a fake studio whose answers the test releases.
const MiB = 1024 * 1024;
const bytes = new Uint8Array(64 * MiB);
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
		const body = new ReadableStream<Uint8Array>({
			async pull(controller) {
				await streamed.promise;
				controller.enqueue(bytes.subarray(0, size));
				controller.close();
			},
			cancel() {
				cancelled.add(src);
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

test("downloads past their 128 MiB share wait for an earlier link to be revoked", async () => {
	const revoke: (() => void)[] = [];
	const realTimeout = globalThis.setTimeout;
	globalThis.setTimeout = ((callback: () => void) => revoke.push(callback)) as never;
	try {
		for (const src of ["/d1", "/d2", "/d3"]) sizes.set(src, 64 * MiB);
		for (const src of ["/d1", "/d2"]) {
			const download = downloadPrivate(src, "video/mp4", "video", "clip.mp4");
			await tick();
			await deliver(src);
			await download;
		}
		// Two links hold 128 MiB, leaving 64 MiB for a shown video: the third download sends
		// nothing and evicts nothing while it waits.
		const shown = show("/kept");
		await tick();
		await deliver("/kept");
		const third = downloadPrivate("/d3", "video/mp4", "video", "clip.mp4");
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
		remount();
		await deliver("/mine");
		await first;
		expect(clicks).toBe(0);
	});
});

test("eviction skips a shown file a download link still holds, which would free nothing", async () => {
	await withLinks(async () => {
		sizes.set("/p1", 64 * MiB);
		sizes.set("/p2", 64 * MiB);
		sizes.set("/p3", 32 * MiB);
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
		await downloadPrivate("/p1", "video/mp4", "video", "clip.mp4");
		sizes.set("/n", 64 * MiB);
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
		const downloads = ["/g1", "/g2", "/g3", "/g4"].map((src) =>
			downloadPrivate(src, "image/png", "image", "a.png"),
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
		for (const src of ["/s1", "/s2", "/big"]) sizes.set(src, 64 * MiB);
		for (const src of ["/s1", "/s2"]) {
			const download = downloadPrivate(src, "video/mp4", "video", "clip.mp4");
			await tick();
			await deliver(src);
			await download;
		}
		show("/big");
		await tick();
		await deliver("/big");
		const reads = calls.length;
		const download = downloadPrivate("/big", "video/mp4", "video", "clip.mp4");
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
		for (const src of ["/t1", "/t2", "/gone"]) sizes.set(src, 64 * MiB);
		for (const src of ["/t1", "/t2"]) {
			const download = downloadPrivate(src, "video/mp4", "video", "clip.mp4");
			await tick();
			await deliver(src);
			await download;
		}
		show("/gone");
		await tick();
		await deliver("/gone");
		const download = downloadPrivate("/gone", "video/mp4", "video", "clip.mp4");
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
async function link(src: string, size: number, kind: "video" | "image") {
	sizes.set(src, size);
	const download = downloadPrivate(src, "video/mp4", kind, "a");
	await tick();
	await deliver(src);
	await download;
}
/** Fill the downloads' 128 MiB share with links of these sizes, oldest first. */
async function fill(...sizes: number[]) {
	for (const [i, size] of sizes.entries())
		await link(`/link${i}`, size, size > 32 * MiB ? "video" : "image");
}

test("a download waiting for its share has sent nothing and leaves every read to shown files", async () => {
	await withLinks(async () => {
		await fill(64 * MiB, 64 * MiB);
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
		await fill(64 * MiB, 32 * MiB, 32 * MiB);
		sizes.set("/older", 64 * MiB);
		sizes.set("/newer", 32 * MiB);
		if (reuse) {
			show("/newer");
			await tick();
			await deliver("/newer");
		}
		const before = calls.length;
		const order: string[] = [];
		const older = downloadPrivate("/older", "video/mp4", "video", "a").then(() =>
			order.push("older"),
		);
		const newer = downloadPrivate("/newer", "image/png", "image", "a").then(() =>
			order.push("newer"),
		);
		await tick();
		// 32 MiB frees: enough for the newer download, not the older one, which keeps its turn.
		revoke[1]();
		await tick();
		await deliver("/newer");
		expect(calls.slice(before)).toEqual([]);
		expect(order).toEqual([]);
		revoke[2]();
		await tick();
		await deliver("/older");
		await older;
		revoke[0]();
		await tick();
		await deliver("/newer");
		await newer;
		expect(order).toEqual(["older", "newer"]);
	});
});

test("a read that stops while waiting for room cancels the body it was answered with", async () => {
	for (const src of ["/h1", "/h2", "/h3", "/h4"]) sizes.set(src, 64 * MiB);
	const signal = () => new AbortController().signal;
	const first = ["/h1", "/h2", "/h3"].map((src) =>
		readPrivate(src, "video/mp4", "video", signal()),
	);
	await tick();
	for (const call of calls) call.answer();
	await tick();
	// Three reads stream 192 MiB, which nothing can evict; the fourth waits for room.
	const stopped = new AbortController();
	const fourth = readPrivate("/h4", "video/mp4", "video", stopped.signal);
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
		await fill(64 * MiB, 64 * MiB);
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
		await fill(64 * MiB, 64 * MiB);
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
		await fill(64 * MiB, 64 * MiB);
		sizes.set("/kept", 32 * MiB);
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
