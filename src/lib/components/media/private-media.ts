import type { Attachment } from "svelte/attachments";
import { galleryImageLimits } from "#lib/shared/gallery/limits.ts";
import type { SessionInit } from "#lib/shared/owner/authenticated-fetch.ts";
import { sessionClient } from "#lib/shared/owner/session-client.ts";

/**
 * Private media reaches the page only as bearer-fetched blobs, never as a URL another page
 * could open ([browser key sessions](../../../../docs/SPEC-browser-key.md#media)).
 */
const MiB = 1024 * 1024;
export const mediaLimits = {
	video: 64 * MiB,
	image: galleryImageLimits.bytes,
	staged: 32_000_000,
} as const;
export type MediaKind = keyof typeof mediaLimits;
/** Per tab: reads in flight and bytes held. */
const maxReads = 4;
const maxBytes = 192 * MiB;
/**
 * Shown files keep one read: downloads take at most three, and pin at most 128 MiB so the
 * largest shown file still fits.
 */
const maxDownloadReads = maxReads - 1;
const maxPinned = maxBytes - mediaLimits.video;
/** A download link outlives its click long enough for the browser to start saving. */
const downloadMs = 60000;

export class MediaUnavailable extends Error {}

type Holder = { src: string; blob: Blob | null; visibleAt: number; evict: () => void };
const holders = new Set<Holder>();
/** Download blobs whose link is not yet revoked, once per link. */
const downloads: Blob[] = [];
/**
 * Bytes that reads in flight declared and are still streaming, and the share downloads have
 * taken: a reading download holds its kind's limit until it declares its length.
 */
let reserved = 0;
let downloadReserved = 0;
const sum = (blobs: Iterable<Blob>, from: number) =>
	[...new Set(blobs)].reduce((total, blob) => total + blob.size, from);
const held = () =>
	sum([...downloads, ...[...holders].flatMap((h) => (h.blob ? [h.blob] : []))], reserved);
/** Bytes download links hold or downloads in flight have taken. */
const pinned = () => sum(downloads, downloadReserved);

let reads = 0;
let downloadReads = 0;
/** Shown reads waiting for a read, oldest first. */
const shownWaiting: (() => void)[] = [];
/** Downloads waiting for their share and, unless they reuse a shown blob, a read: in click order. */
type Turn = {
	src: string;
	kind: MediaKind;
	/** False once the download's session or page is gone; it then leaves the queue. */
	live: () => boolean;
	drop: () => void;
	start: (from: { shown: Blob } | { share: number }) => void;
};
const turns: Turn[] = [];
const shownBlob = (src: string) => [...holders].find((h) => h.src === src && h.blob)?.blob;
let dispatching = false;
/** Admit the oldest download if its share and a read are free, then shown reads. */
function dispatch() {
	// A download dropped here re-enters through its abort; this loop sees the change.
	if (dispatching) return;
	dispatching = true;
	try {
		admit();
	} finally {
		dispatching = false;
	}
}
function admit() {
	for (;;) {
		const turn = turns[0];
		if (turn && !turn.live()) {
			turns.shift();
			turn.drop();
			continue;
		}
		if (turn) {
			const shown = shownBlob(turn.src);
			const need = shown ? shown.size : mediaLimits[turn.kind];
			const fits = (shown && downloads.includes(shown)) || pinned() + need <= maxPinned;
			// A shown file goes first unless no download is reading, so neither can starve.
			const read =
				reads < maxReads &&
				downloadReads < maxDownloadReads &&
				(downloadReads === 0 || shownWaiting.length === 0);
			if (fits && (shown || read)) {
				turns.shift();
				if (shown) {
					downloads.push(shown);
					turn.start({ shown });
				} else {
					reads++;
					downloadReads++;
					downloadReserved += need;
					turn.start({ share: need });
				}
				continue;
			}
		}
		if (reads >= maxReads || !shownWaiting.length) return;
		reads++;
		shownWaiting.shift()?.();
	}
}
/** Wait in the queue `add` joins until `dispatch` starts this entry. An abort leaves at once. */
function enqueue<T, E>(
	signal: AbortSignal,
	add: (start: (value: T) => void) => E,
	remove: (entry: E) => void,
) {
	signal.throwIfAborted();
	return new Promise<T>((resolve, reject) => {
		const abort = () => {
			remove(entry);
			reject(signal.reason);
			dispatch();
		};
		const entry = add((value) => {
			signal.removeEventListener("abort", abort);
			resolve(value);
		});
		signal.addEventListener("abort", abort, { once: true });
		dispatch();
	});
}
const without = <T>(list: T[], entry: T) => {
	const index = list.indexOf(entry);
	if (index >= 0) list.splice(index, 1);
};
/** Take one of the tab's reads for a shown file. */
const slot = (signal: AbortSignal) =>
	enqueue<void, () => void>(
		signal,
		(start) => {
			const entry = () => start();
			shownWaiting.push(entry);
			return entry;
		},
		(entry) => without(shownWaiting, entry),
	);
function free(download: boolean) {
	reads--;
	if (download) downloadReads--;
	dispatch();
}
/**
 * Make room for `size` bytes, evicting the least recently visible holders first. Nothing is
 * evicted when evicting every shown file would still leave too little room.
 */
function makeRoom(size: number, keep: Holder | null) {
	// A blob a download link still holds frees nothing when its tile is evicted.
	const linked = new Set(downloads);
	const others = [...holders]
		.filter((h) => h !== keep && h.blob && !linked.has(h.blob))
		.sort((a, b) => a.visibleAt - b.visibleAt);
	const evictable = new Set(others.flatMap((h) => (h.blob ? [h.blob] : [])));
	const freeable = [...evictable].reduce((sum, blob) => sum + blob.size, 0);
	if (held() - freeable + size > maxBytes) return;
	while (held() + size > maxBytes && others.length) others.shift()?.evict();
}
/** Reads waiting for other reads or download links to release their bytes. */
const roomWaiters = new Set<() => void>();
function released() {
	for (const wake of [...roomWaiters]) wake();
	dispatch();
}
/** Wait until something releases bytes. */
function roomFreed(signal: AbortSignal) {
	return new Promise<void>((resolve, reject) => {
		const abort = () => {
			roomWaiters.delete(wake);
			reject(signal.reason);
		};
		const wake = () => {
			roomWaiters.delete(wake);
			signal.removeEventListener("abort", abort);
			resolve();
		};
		roomWaiters.add(wake);
		signal.addEventListener("abort", abort, { once: true });
	});
}
/**
 * Reserve `size` bytes of the tab's limit: evict what is shown, then wait for reads in flight
 * and download links, which cannot be evicted, to release theirs.
 */
async function reserve(size: number, keep: Holder | null, signal: AbortSignal) {
	for (;;) {
		signal.throwIfAborted();
		makeRoom(size, keep);
		if (held() + size <= maxBytes) {
			reserved += size;
			return;
		}
		await roomFreed(signal);
	}
}
/** The session a read belongs to, captured before it waits for a read. */
const currentSession = () => sessionClient().bound()?.sessionId;

/**
 * Read one private file through the page's authenticated fetch once it has a read, refusing
 * more than the kind's limit. The blob's type is the saved type, never the response's. Its
 * `owner`, a holder or the download list, takes the blob before the read releases its
 * reservation, so the bytes never go uncounted. A download arrives with its share taken.
 */
async function read(
	src: string,
	mime: string,
	kind: MediaKind,
	signal: AbortSignal,
	owner: Holder | Blob[] | null,
	session: string | undefined,
	share = { bytes: 0 },
) {
	const download = Array.isArray(owner);
	const holder = download ? null : owner;
	let reservation = 0;
	try {
		const init: SessionInit = { signal, cache: "no-store", siluetSession: session };
		const response = await fetch(src, init);
		if (response.status === 404 || response.status === 410) throw new MediaUnavailable();
		if (!response.ok || !response.body) throw new TypeError("The file could not be read.");
		const body = response.body;
		const limit = mediaLimits[kind];
		const length = response.headers.get("content-length")?.trim();
		const declared = length && /^\d+$/.test(length) ? Number(length) : Number.NaN;
		if (declared > limit) {
			await body.cancel().catch(() => {});
			throw new MediaUnavailable();
		}
		// A file of unknown or malformed length may use the kind's whole limit.
		const expected = Number.isFinite(declared) ? declared : limit;
		if (download) {
			// The share was the kind's limit; keep only the declared size.
			downloadReserved -= share.bytes - expected;
			share.bytes = expected;
			released();
		}
		try {
			await reserve(expected, holder, signal);
		} catch (error) {
			await body.cancel().catch(() => {});
			throw error;
		}
		reservation = expected;
		const chunks: Uint8Array<ArrayBuffer>[] = [];
		let size = 0;
		const reader = body.getReader();
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > limit) {
				await reader.cancel();
				throw new MediaUnavailable();
			}
			chunks.push(value);
		}
		const blob = new Blob(chunks, { type: mime });
		if (!signal.aborted) {
			if (Array.isArray(owner)) owner.push(blob);
			else if (owner) owner.blob = blob;
		}
		return blob;
	} finally {
		reserved -= reservation;
		downloadReserved -= share.bytes;
		share.bytes = 0;
		free(download);
		released();
	}
}

/** Read one private file for a shown element or a caller, waiting for one of the tab's reads. */
export async function readPrivate(
	src: string,
	mime: string,
	kind: MediaKind,
	signal: AbortSignal,
	holder: Holder | null = null,
	session = currentSession(),
) {
	await slot(signal);
	return read(src, mime, kind, signal, holder, session);
}

/**
 * Show a private file in an `<img>` or `<video>`, a lazy one once it is near the viewport. Its object URL
 * is revoked on unmount or when the tab needs the room for a more recently visible file.
 */
export function privateSource(
	src: string,
	mime: string,
	kind: MediaKind,
	on: { failed?: (unavailable: boolean) => void; lazy?: boolean } = {},
): Attachment<HTMLImageElement | HTMLVideoElement> {
	return (element) => {
		let controller: AbortController | null = null;
		let url: string | null = null;
		let visible = false;
		const holder: Holder = {
			src,
			blob: null,
			visibleAt: 0,
			evict() {
				controller?.abort();
				controller = null;
				holder.blob = null;
				element.removeAttribute("src");
				if (url) URL.revokeObjectURL(url);
				url = null;
				released();
			},
		};
		holders.add(holder);
		async function load() {
			if (holder.blob || controller) return;
			const current = new AbortController();
			controller = current;
			try {
				const blob = await readPrivate(src, mime, kind, current.signal, holder);
				// `readPrivate` already gave the holder its blob.
				if (controller !== current) return;
				url = URL.createObjectURL(blob);
				element.src = url;
			} catch (error) {
				if (controller !== current || (error as Error)?.name === "AbortError") return;
				on.failed?.(error instanceof MediaUnavailable);
			} finally {
				if (controller === current) controller = null;
			}
		}
		const observer = new IntersectionObserver(
			([entry]) => {
				visible = entry?.isIntersecting ?? false;
				if (visible) {
					holder.visibleAt = performance.now();
					void load();
				}
			},
			{ rootMargin: "200px" },
		);
		observer.observe(element);
		// Only grid tiles wait to be near the viewport; a viewer or staged copy loads at once.
		if (!on.lazy) {
			holder.visibleAt = performance.now();
			void load();
		}
		return () => {
			observer.disconnect();
			holder.evict();
			holders.delete(holder);
		};
	};
}

/** Downloads still reading, by session generation and source: a second click joins the first. */
const downloading = new Map<string, Promise<void>>();

/**
 * Download a private file under its Gallery name, reusing a blob already shown on the page.
 * Downloads take their share and read in click order. The temporary link is revoked a minute
 * after the click; until then its bytes count against the downloads' share. A remount stops a
 * download at once; one whose tab is leaving is dropped before it starts or saves nothing.
 */
export function downloadPrivate(src: string, mime: string, kind: MediaKind, name: string) {
	const client = sessionClient();
	const started = client.remountKey;
	const key = `${started}:${src}`;
	const pending = downloading.get(key);
	if (pending) return pending;
	const session = currentSession();
	const controller = new AbortController();
	const { signal } = controller;
	const live = () => sessionClient().remountKey === started && !sessionClient().leaving;
	const unsubscribe = client.subscribe(() => {
		if (!live()) controller.abort();
	});
	const download = (async () => {
		/** The blob this download added to the link list, once. */
		let linked: Blob | null = null;
		let url: string | null = null;
		try {
			const from = await enqueue<{ shown: Blob } | { share: number }, Turn>(
				signal,
				(start) => {
					const turn: Turn = { src, kind, live, drop: () => controller.abort(), start };
					turns.push(turn);
					return turn;
				},
				(entry) => without(turns, entry),
			);
			if ("shown" in from) linked = from.shown;
			else {
				// The blob joins the link list before the read releases its share, unless it stopped.
				const blob = await read(src, mime, kind, signal, downloads, session, {
					bytes: from.share,
				});
				if (downloads.includes(blob)) linked = blob;
			}
			if (!linked || !live()) return;
			url = URL.createObjectURL(linked);
			const link = document.createElement("a");
			link.href = url;
			link.download = name;
			link.hidden = true;
			document.body.append(link);
			link.click();
			link.remove();
		} catch (error) {
			// A stale download stops quietly; only a live one reports a failure.
			if (live()) throw error;
		} finally {
			unsubscribe();
			const href = url;
			const kept = linked;
			const forget = () => {
				if (href) URL.revokeObjectURL(href);
				if (kept) without(downloads, kept);
				released();
			};
			if (href) setTimeout(forget, downloadMs);
			else forget();
		}
	})().finally(() => downloading.delete(key));
	downloading.set(key, download);
	return download;
}
