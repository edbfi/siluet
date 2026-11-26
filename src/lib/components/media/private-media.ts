import type { Attachment } from "svelte/attachments";
import type { SessionInit } from "#lib/shared/owner/authenticated-fetch.ts";
import { sessionClient } from "#lib/shared/owner/session-client.ts";

/**
 * Private media reaches the page only as bearer-fetched blobs, never as a URL another page
 * could open ([browser key sessions](../../../../docs/SPEC-browser-key.md#media)).
 */
const MiB = 1024 * 1024;
export const mediaLimits = { video: 64 * MiB, image: 32 * MiB, staged: 32_000_000 } as const;
export type MediaKind = keyof typeof mediaLimits;
/** Per tab: reads in flight and bytes held. */
const maxReads = 4;
const maxBytes = 192 * MiB;
/**
 * Shown files keep priority: downloads take at most three reads, wait behind any shown file
 * that wants one, and pin at most 128 MiB, so the largest shown file still fits.
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
/** Bytes that reads in flight declared and are still streaming, and the downloads' share. */
let reserved = 0;
let downloadReserved = 0;
const sum = (blobs: Iterable<Blob>, from: number) =>
	[...new Set(blobs)].reduce((total, blob) => total + blob.size, from);
const held = () =>
	sum([...downloads, ...[...holders].flatMap((h) => (h.blob ? [h.blob] : []))], reserved);
/** Bytes download links hold or download reads have reserved. */
const pinned = () => sum(downloads, downloadReserved);

let reads = 0;
let downloadReads = 0;
type Waiter = { download: boolean; start: () => void };
const waiting: Waiter[] = [];
/** Start waiting reads while the tab has room: shown files first, then downloads in order. */
function dispatch() {
	while (reads < maxReads) {
		const next =
			waiting.find((w) => !w.download) ??
			(downloadReads < maxDownloadReads ? waiting.find((w) => w.download) : undefined);
		if (!next) return;
		waiting.splice(waiting.indexOf(next), 1);
		reads++;
		if (next.download) downloadReads++;
		next.start();
	}
}
/** Take one of the tab's reads. An abort while waiting leaves the queue and rejects at once. */
function slot(signal: AbortSignal, download: boolean) {
	signal.throwIfAborted();
	return new Promise<void>((resolve, reject) => {
		const abort = () => {
			waiting.splice(waiting.indexOf(waiter), 1);
			reject(signal.reason);
		};
		const waiter: Waiter = {
			download,
			start() {
				signal.removeEventListener("abort", abort);
				resolve();
			},
		};
		waiting.push(waiter);
		signal.addEventListener("abort", abort, { once: true });
		dispatch();
	});
}
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
 * and download links, which cannot be evicted, to release theirs. A download first waits for
 * its share, evicting nothing until it fits.
 */
async function reserve(size: number, keep: Holder | null, signal: AbortSignal, download: boolean) {
	for (;;) {
		signal.throwIfAborted();
		const share = !download || pinned() + size <= maxPinned;
		if (share) makeRoom(size, keep);
		if (share && held() + size <= maxBytes) {
			reserved += size;
			if (download) downloadReserved += size;
			return;
		}
		await roomFreed(signal);
	}
}
/** The session a read belongs to, captured before it waits for a read. */
const currentSession = () => sessionClient().bound()?.sessionId;

/**
 * Read one private file through the page's authenticated fetch, refusing more than the
 * kind's limit. The blob's type is the saved type, never the response's. Its `owner`, a
 * holder or the download list, takes the blob before the read releases its reservation, so
 * the bytes never go uncounted.
 */
export async function readPrivate(
	src: string,
	mime: string,
	kind: MediaKind,
	signal: AbortSignal,
	owner: Holder | Blob[] | null = null,
	session = currentSession(),
) {
	const download = Array.isArray(owner);
	const holder = download ? null : owner;
	await slot(signal, download);
	let reservation = 0;
	try {
		const init: SessionInit = { signal, cache: "no-store", siluetSession: session };
		const response = await fetch(src, init);
		if (response.status === 404 || response.status === 410) throw new MediaUnavailable();
		if (!response.ok || !response.body) throw new TypeError("The file could not be read.");
		const limit = mediaLimits[kind];
		const length = response.headers.get("content-length")?.trim();
		const declared = length && /^\d+$/.test(length) ? Number(length) : Number.NaN;
		if (declared > limit) throw new MediaUnavailable();
		// A file of unknown or malformed length may use the kind's whole limit.
		const expected = Number.isFinite(declared) ? declared : limit;
		await reserve(expected, holder, signal, download);
		reservation = expected;
		const chunks: Uint8Array<ArrayBuffer>[] = [];
		let size = 0;
		const reader = response.body.getReader();
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
		if (download) downloadReserved -= reservation;
		free(download);
		released();
	}
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

/**
 * Pin the blob already shown for `src` to a download link once the downloads' share has room
 * for it, or return null when no shown blob remains to reuse.
 */
async function linkShown(src: string, signal: AbortSignal) {
	for (;;) {
		const shown = [...holders].find((h) => h.src === src && h.blob)?.blob;
		if (!shown) return null;
		if (downloads.includes(shown) || pinned() + shown.size <= maxPinned) {
			downloads.push(shown);
			return shown;
		}
		await roomFreed(signal);
	}
}

/** Downloads still reading, by session generation and source: a second click joins the first. */
const downloading = new Map<string, Promise<void>>();

/**
 * Download a private file under its Gallery name, reusing a blob already shown on the page.
 * The temporary link is revoked a minute after the click; until then its bytes count against
 * the downloads' share, so a download past it waits for an earlier link to go. A download
 * whose session ended while it waited saves nothing.
 */
export function downloadPrivate(src: string, mime: string, kind: MediaKind, name: string) {
	const started = sessionClient().remountKey;
	const key = `${started}:${src}`;
	const pending = downloading.get(key);
	if (pending) return pending;
	const session = currentSession();
	const download = (async () => {
		const signal = new AbortController().signal;
		const blob =
			(await linkShown(src, signal)) ??
			(await readPrivate(src, mime, kind, signal, downloads, session));
		let url: string | null = null;
		try {
			if (sessionClient().remountKey !== started || sessionClient().leaving) return;
			url = URL.createObjectURL(blob);
			const link = document.createElement("a");
			link.href = url;
			link.download = name;
			link.hidden = true;
			document.body.append(link);
			link.click();
			link.remove();
		} finally {
			const linked = url;
			const forget = () => {
				if (linked) URL.revokeObjectURL(linked);
				downloads.splice(downloads.indexOf(blob), 1);
				released();
			};
			if (linked) setTimeout(forget, downloadMs);
			else forget();
		}
	})().finally(() => downloading.delete(key));
	downloading.set(key, download);
	return download;
}
