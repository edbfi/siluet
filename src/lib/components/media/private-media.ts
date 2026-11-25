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
/** A download link outlives its click long enough for the browser to start saving. */
const downloadMs = 60000;

export class MediaUnavailable extends Error {}

type Holder = { src: string; blob: Blob | null; visibleAt: number; evict: () => void };
const holders = new Set<Holder>();
/** Download blobs whose link is not yet revoked, once per link. */
const downloads: Blob[] = [];
/** Bytes that reads in flight declared and are still streaming. */
let reserved = 0;
let reads = 0;
const waiting: (() => void)[] = [];
const held = () => {
	const blobs = new Set(downloads);
	for (const holder of holders) if (holder.blob) blobs.add(holder.blob);
	return [...blobs].reduce((sum, blob) => sum + blob.size, reserved);
};

/** Take one of the tab's reads. An abort while waiting leaves the queue and rejects at once. */
function slot(signal: AbortSignal) {
	signal.throwIfAborted();
	if (reads < maxReads) {
		reads++;
		return Promise.resolve();
	}
	return new Promise<void>((resolve, reject) => {
		const abort = () => {
			waiting.splice(waiting.indexOf(next), 1);
			reject(signal.reason);
		};
		// `free` hands its read straight to the next waiter.
		const next = () => {
			signal.removeEventListener("abort", abort);
			resolve();
		};
		waiting.push(next);
		signal.addEventListener("abort", abort, { once: true });
	});
}
function free() {
	const next = waiting.shift();
	if (next) next();
	else reads--;
}
/** Make room for `size` bytes, evicting the least recently visible holders first. */
function makeRoom(size: number, keep: Holder | null) {
	const others = [...holders]
		.filter((h) => h !== keep && h.blob)
		.sort((a, b) => a.visibleAt - b.visibleAt);
	while (held() + size > maxBytes && others.length) others.shift()?.evict();
}
/** The session a read belongs to, captured before it waits for a read. */
const currentSession = () => sessionClient().bound()?.sessionId;

/**
 * Read one private file through the page's authenticated fetch, refusing more than the
 * kind's limit. The blob's type is the saved type, never the response's.
 */
export async function readPrivate(
	src: string,
	mime: string,
	kind: MediaKind,
	signal: AbortSignal,
	holder: Holder | null = null,
	session = currentSession(),
) {
	await slot(signal);
	let reservation = 0;
	try {
		const init: SessionInit = { signal, cache: "no-store", siluetSession: session };
		const response = await fetch(src, init);
		if (response.status === 404 || response.status === 410) throw new MediaUnavailable();
		if (!response.ok || !response.body) throw new TypeError("The file could not be read.");
		const limit = mediaLimits[kind];
		const declared = Number(response.headers.get("content-length") ?? Number.NaN);
		if (declared > limit) throw new MediaUnavailable();
		reservation = Number.isFinite(declared) ? declared : 0;
		makeRoom(reservation, holder);
		reserved += reservation;
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
		return new Blob(chunks, { type: mime });
	} finally {
		reserved -= reservation;
		free();
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
			},
		};
		holders.add(holder);
		async function load() {
			if (holder.blob || controller) return;
			const current = new AbortController();
			controller = current;
			try {
				const blob = await readPrivate(src, mime, kind, current.signal, holder);
				if (controller !== current) return;
				makeRoom(blob.size, holder);
				holder.blob = blob;
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
 * Download a private file under its Gallery name, reusing a blob already shown on the page.
 * The temporary link is revoked a minute after the click.
 */
export async function downloadPrivate(src: string, mime: string, kind: MediaKind, name: string) {
	const shown = [...holders].find((h) => h.src === src && h.blob);
	const blob = shown?.blob ?? (await readPrivate(src, mime, kind, new AbortController().signal));
	downloads.push(blob);
	makeRoom(0, shown ?? null);
	const url = URL.createObjectURL(blob);
	const link = document.createElement("a");
	link.href = url;
	link.download = name;
	link.hidden = true;
	document.body.append(link);
	link.click();
	link.remove();
	setTimeout(() => {
		URL.revokeObjectURL(url);
		downloads.splice(downloads.indexOf(blob), 1);
	}, downloadMs);
}
