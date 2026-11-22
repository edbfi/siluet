import { createHash } from "node:crypto";
import sharp from "sharp";
import type { PreparedStageMedia } from "../../../shared/media-staging/descriptor";
import { type RuntimeInstallation, runtimeEntry } from "../../db/runtime-installation";
import { cleanJpeg, JpegCleanupError } from "./jpeg";
import { cleanPng, PngCleanupError } from "./png";
import {
	failure,
	maxPreparationBytes,
	mediaMime,
	PreparationError,
	readBounded,
} from "./preparation-bytes";

// libvips' operation cache would retain decoded pixels between requests. Disable it
// for the whole server process, which also covers Gallery verification.
// https://sharp.pixelplumbing.com/api-utility/#cache
sharp.cache(false);

export { PreparationError };
export type PreparedMedia = PreparedStageMedia;

export const preparationMs = 30_000;

/** What stops a preparation: its request, shutdown and timer, and its monotonic deadline. */
export type PreparationStop = { signal: AbortSignal; deadline: number };

export type Cleaners = {
	jpeg: (
		bytes: Uint8Array,
		options: { signal: AbortSignal },
	) => Promise<{ bytes: Uint8Array; transform: "none" | "reencoded-rotation" }>;
	png: (bytes: Uint8Array, options: { signal: AbortSignal }) => Promise<Uint8Array>;
};
const qualified: Cleaners = { jpeg: cleanJpeg, png: cleanPng };

/**
 * Take the installation's one preparation slot or refuse with "busy". The slot is
 * recorded in the process registry entry, so a reloaded module sees it, and is
 * released only after every tracked promise has settled.
 */
export function acquirePreparation(installation: RuntimeInstallation) {
	const entry = runtimeEntry(installation);
	if (entry.preparation) throw failure("busy");
	const work = new Set<Promise<unknown>>();
	const settled = Promise.withResolvers<void>();
	const slot = { settled: settled.promise };
	entry.preparation = slot;
	let released = false;
	return {
		/** Keep the slot until this promise settles, even if its caller stops waiting. */
		track<T>(promise: Promise<T>) {
			work.add(promise);
			return promise;
		},
		release() {
			if (released) return;
			released = true;
			void Promise.allSettled(work).then(() => {
				if (entry.preparation === slot) entry.preparation = undefined;
				settled.resolve();
			});
		},
		[Symbol.dispose]() {
			this.release();
		},
	};
}

// Stages need bytes that own their whole ArrayBuffer. Copy only a pooled or partial view.
function exact(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
	const { buffer, byteOffset, byteLength } = bytes;
	return buffer instanceof ArrayBuffer && byteOffset === 0 && byteLength === buffer.byteLength
		? new Uint8Array(buffer)
		: new Uint8Array(bytes);
}

function refusal(error: unknown) {
	if (error instanceof JpegCleanupError && error.code !== "cancelled")
		return new PreparationError("declined", [error.message, error.advice]);
	if (error instanceof PngCleanupError && error.code !== "cancelled")
		return new PreparationError("declined", [error.message, error.guidance]);
	return error instanceof PreparationError ? error : failure("failed");
}

export function createMediaPreparation(
	installation: RuntimeInstallation,
	{
		shutdown,
		cleaners = qualified,
		deadlineMs = preparationMs,
		monotonic = () => performance.now(),
	}: {
		shutdown?: AbortSignal;
		cleaners?: Cleaners;
		deadlineMs?: number;
		monotonic?: () => number;
	} = {},
) {
	/**
	 * Read, clean and verify one file, then hand it to `commit` (the stage write)
	 * while still holding the slot. The deadline starts at admission. `commit`
	 * receives the request, shutdown and timer as one signal plus the monotonic
	 * deadline, and must not write or publish once either stops it. The slot
	 * waits for the write and any rollback.
	 */
	return async function prepareMedia<T>(
		source: Uint8Array | ReadableStream<Uint8Array>,
		signal: AbortSignal,
		commit: (media: PreparedMedia, stop: PreparationStop) => Promise<T>,
	): Promise<T> {
		const deadline = monotonic() + deadlineMs;
		const timeout = new AbortController();
		const stopped = AbortSignal.any(
			shutdown ? [signal, shutdown, timeout.signal] : [signal, timeout.signal],
		);
		const check = () => {
			if (timeout.signal.aborted || monotonic() >= deadline) throw failure("timeout");
			if (signal.aborted || shutdown?.aborted) throw failure("cancelled");
		};
		const cancelSource = () => {
			if (source instanceof ReadableStream && !source.locked) void source.cancel().catch(() => {});
		};
		let slot: ReturnType<typeof acquirePreparation>;
		try {
			check();
			slot = acquirePreparation(installation);
		} catch (error) {
			cancelSource();
			throw error instanceof PreparationError ? error : failure("failed");
		}
		const timer = setTimeout(() => timeout.abort(), deadlineMs);
		// Reject promptly on abort. The slot still waits for the tracked work.
		const interrupted = new Promise<never>((_, reject) => {
			stopped.addEventListener("abort", () => reject(new Error("stopped")), { once: true });
		});
		interrupted.catch(() => {});
		const race = <V>(work: Promise<V>) => Promise.race([slot.track(work), interrupted]);
		let committing = false;
		try {
			const input =
				source instanceof Uint8Array
					? source
					: // A cancelled request body may never settle its pending read. It holds no
						// native work, so the slot does not wait for it.
						await Promise.race([
							readBounded(source, maxPreparationBytes, check, stopped),
							interrupted,
						]);
			check();
			if (input.byteLength > maxPreparationBytes) throw failure("limit");
			const mime = mediaMime(input);
			if (!mime) throw failure("format");
			const cleaned =
				mime === "image/jpeg"
					? await race(cleaners.jpeg(input, { signal: stopped }))
					: {
							bytes: await race(cleaners.png(input, { signal: stopped })),
							transform: "none" as const,
						};
			check();
			const bytes = exact(cleaned.bytes);
			if (mediaMime(bytes) !== mime) throw failure("failed");
			const digest = createHash("sha256").update(bytes).digest("hex");
			const media: PreparedMedia =
				mime === "image/jpeg"
					? { bytes, digest, mime, size: bytes.length, transform: cleaned.transform }
					: { bytes, digest, mime, size: bytes.length, transform: "none" };
			committing = true;
			return await slot.track(commit(media, { signal: stopped, deadline }));
		} catch (error) {
			cancelSource();
			check();
			if (committing) throw error;
			throw refusal(error);
		} finally {
			clearTimeout(timer);
			slot.release();
		}
	};
}
export type MediaPreparation = ReturnType<typeof createMediaPreparation>;
