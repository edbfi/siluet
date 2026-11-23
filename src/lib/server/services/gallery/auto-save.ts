import { rm } from "node:fs/promises";
import { basename } from "node:path";
import {
	type ImageJob,
	imageJobStore,
	isReadPaused,
	isVideoJob,
	type SaveHold,
} from "../../db/image-job-store";
import type { RuntimeInstallation } from "../../db/runtime-installation";
import { saveIntentStore, saveTryLimit } from "../../db/save-intent";
import type { SaveRead } from "../jobs/tracking";
import { downloadVideo, type VideoDelivery } from "../video-media/download";
import { UnsupportedVideoError } from "../video-media/errors";
import { verifyVideoFile } from "../video-media/verify-video";
import { direct, downloadImage, type Transport } from "./download";
import { galleryStorage, type Publication, unremovedScratch } from "./storage";
import { UnsupportedGalleryImage, verifyImage } from "./verify-image";

type AutoSaveDependencies = {
	/** One status read for this job under its cooldown, gate and key; never a submission. */
	readForSave: (id: string) => Promise<SaveRead>;
	/** Whether each job's original key is still current and readable. */
	readability: () => Promise<(job: ImageJob) => boolean>;
	now?: () => number;
	transport?: Transport;
	transferImage?: typeof downloadImage;
	transferVideo?: typeof downloadVideo;
	/** Delays before the second and third try of a failed download. */
	backoff?: readonly [number, number];
};

// At most two image and one video transfer at a time; the rest wait.
const caps = { image: 2, video: 1 };

/** A complete file outside the Gallery profile; another download cannot change it. */
function refusal(error: unknown): SaveHold | null {
	if (error instanceof UnsupportedGalleryImage) return "unsupported";
	if (error instanceof UnsupportedVideoError)
		return error.reason === "webm" ? "webm" : "unsupported";
	return null;
}

/**
 * Carries out every durable save intent (D9): claims it, downloads from the delivery the
 * completing read observed (or one recovery read), verifies and publishes under the fence.
 * Signed links stay in this memory only.
 */
export function createAutoSave(
	installation: RuntimeInstallation,
	{
		readForSave,
		readability,
		now = Date.now,
		transport = direct,
		transferImage = downloadImage,
		transferVideo = downloadVideo,
		backoff = [30_000, 120_000],
	}: AutoSaveDependencies,
) {
	const saves = saveIntentStore(installation);
	const jobs = imageJobStore(installation);
	const storage = galleryStorage(installation);
	const deliveries = new Map<string, VideoDelivery>();
	// A first completion whose read carried no usable link.
	const linkless = new Set<string>();
	const active = new Map<string, { video: boolean; done: Promise<void> }>();
	const shutdown = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	let started = false;
	let filling = false;
	let again = false;

	const expired = (job: ImageJob) => job.expires_at !== null && job.expires_at <= now();
	const running = (video: boolean) =>
		[...active.values()].filter((attempt) => attempt.video === video).length;

	async function publish(job: ImageJob, token: string, delivery: VideoDelivery) {
		const { signal } = shutdown;
		if (!isVideoJob(job)) {
			const bytes = await transferImage(delivery.url, transport, signal);
			return storage.publish(job.id, token, bytes, await verifyImage(bytes));
		}
		const path = storage.scratchPath(token);
		try {
			const bytes = await transferVideo(delivery, path, transport, signal);
			const info = await verifyVideoFile(path);
			return await storage.publishVideo(job.id, path, token, { ...bytes, ...info });
		} finally {
			// Publication renames the scratch away; any other outcome discards only this attempt's file.
			await rm(path, { force: true }).catch(() => unremovedScratch(basename(path)));
		}
	}

	async function failed(job: ImageJob, token: string) {
		const tries = job.save_tries + 1;
		if (tries >= saveTryLimit) {
			deliveries.delete(job.id);
			return saves.hold(job.id, token, "failed", saveTryLimit);
		}
		return saves.defer(job.id, token, now() + backoff[tries - 1], tries);
	}

	/** Resolves false when the intent was no longer claimable, so nothing changed. */
	async function attempt(id: string, token: string) {
		const job = await saves.claim(id, token, now());
		if (!job) return false;
		try {
			if (expired(job)) {
				deliveries.delete(id);
				linkless.delete(id);
				await saves.expire(id, token);
				return true;
			}
			if (linkless.delete(id)) {
				await saves.hold(id, token, "failed");
				return true;
			}
			let delivery = deliveries.get(id);
			if (!delivery) {
				const read = await readForSave(id);
				if (shutdown.signal.aborted) throw shutdown.signal.reason;
				// Only a read that ran without a usable link counts as a failed try.
				if (read.kind === "cooldown") await saves.defer(id, token, read.until, job.save_tries);
				else if (read.kind === "paused") await saves.release(id, token);
				else if (read.kind === "expired") await saves.expire(id, token);
				else if (read.kind === "failed") await failed(job, token);
				if (read.kind !== "delivered") return true;
				delivery = read.delivery;
				deliveries.set(id, delivery);
			}
			const publication: Publication = await publish(job, token, delivery);
			if (publication === "saved") deliveries.delete(id);
			// A replaced key leaves the claim in place; give it back. Remove already cleared it.
			else await saves.release(id, token);
		} catch (error) {
			// Shutdown never counts as a failure.
			if (shutdown.signal.aborted) await saves.release(id, token).catch(() => {});
			else {
				const hold = refusal(error);
				if (hold) {
					deliveries.delete(id);
					await saves.hold(id, token, hold);
				} else await failed(job, token);
			}
		}
		return true;
	}

	function begin(job: ImageJob) {
		const video = isVideoJob(job);
		const token = crypto.randomUUID();
		const done = attempt(job.id, token)
			.catch(() => true)
			.then((changed) => {
				active.delete(job.id);
				// A finished attempt frees a slot; a missed claim changed nothing to look at again.
				if (changed) wake();
			});
		active.set(job.id, { video, done });
	}

	async function fill() {
		const time = now();
		const due = await saves.pendingSaves(time);
		const readable = due.length ? await readability() : () => false;
		for (const job of due) {
			if (shutdown.signal.aborted) return;
			if (active.has(job.id)) continue;
			// Expiry and a link-less completion need no transfer slot.
			const settleOnly = expired(job) || linkless.has(job.id);
			if (!settleOnly) {
				// Paused and key-less jobs wait for Refresh or stay as they are; nothing polls.
				if (isReadPaused(job.pause_reason) || !readable(job)) continue;
				const video = isVideoJob(job);
				if (running(video) >= caps[video ? "video" : "image"]) continue;
			}
			begin(job);
		}
		clearTimeout(timer);
		const next = await saves.nextDue(time);
		if (next !== null && !shutdown.signal.aborted)
			timer = setTimeout(wake, Math.max(0, next - now())).unref();
	}

	function wake() {
		if (!started || shutdown.signal.aborted) return;
		if (filling) {
			again = true;
			return;
		}
		filling = true;
		void (async () => {
			try {
				do {
					again = false;
					await fill();
				} while (again && !shutdown.signal.aborted);
			} catch {
				// Storage is closing or busy; the next event or restart resumes the intent.
			} finally {
				filling = false;
			}
		})();
	}

	return {
		/** Start (or look again) after startup recovery cleared abandoned attempts. */
		start() {
			started = true;
			wake();
		},
		/** The tracking handoff after a status read committed (never awaited by it). */
		deliver(id: string, delivery: VideoDelivery | null, armed: boolean) {
			if (shutdown.signal.aborted) return;
			if (delivery) deliveries.set(id, delivery);
			else if (armed) linkless.add(id);
			wake();
		},
		/** Retry download or Download again: one fresh status read, never a submission. */
		async retry(id: string) {
			if (shutdown.signal.aborted) return false;
			// The original key must still decrypt, as the Jobs retry flag requires.
			const job = await jobs.get(id);
			if (!job || !(await readability())(job) || !(await saves.retry(id, now()))) return false;
			deliveries.delete(id);
			linkless.delete(id);
			wake();
			return true;
		},
		/** Resolves once no attempt is running (tests). */
		async idle() {
			while (filling || active.size) {
				await Promise.all([...active.values()].map((entry) => entry.done));
				await Bun.sleep(1);
			}
		},
		/** Stop admission, abort transfers and wait for active attempts to give their claims back. */
		async close() {
			shutdown.abort(new Error("Siluet is stopping."));
			clearTimeout(timer);
			while (active.size) await Promise.all([...active.values()].map((entry) => entry.done));
			deliveries.clear();
			linkless.clear();
		},
	};
}
