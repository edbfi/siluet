import type { EventEmitter } from "node:events";
import { fileAttemptStore } from "../../db/file-attempt";
import { mediaCleaning } from "../../db/media-cleaning";
import { modelRefusals } from "../../db/model-refusal";
import { providerStore } from "../../db/provider-store";
import { openRuntimeInstallation, runtimeEntry } from "../../db/runtime-installation";
import { saveIntentStore } from "../../db/save-intent";
import { checkRequestSecurity, cleanUnusedKeys } from "../../db/security-state";
import { closeRequestlessOnStop } from "../../http/stop-connections";
import { requireSupportedPlatform } from "../../platform";
import { checkPoyoConnection } from "../../providers/poyo/connection";
import { checkToapisConnection } from "../../providers/toapis/connection";
import { fileDispatcher } from "../file-edit/dispatch";
import { createFileQueue } from "../file-edit/queue";
import { createAutoSave } from "../gallery/auto-save";
import { createGallery } from "../gallery/gallery";
import { createJobTracking } from "../jobs/tracking";
import { createMediaPreparation } from "../media-cleanup/preparation";
import { createScratchPool } from "../media-staging/scratch";
import { createStages } from "../media-staging/stages";
import { createProviderConnections } from "../providers/connections";
import { createVideoAccess } from "../providers/video-access";
import { createSubmissionQueue } from "../queue/submission";
import { createVideoQueue } from "../queue/video";
import { createOwnerAccess, rotationMs } from "./access";
import { AccessError } from "./access-error";
import { createBearers } from "./bearers";
import { createBrowserSessions } from "./browser-session";
import { createChallenges } from "./challenges";
import { ownerDirectory } from "./data-directory";
import { studioOrigin } from "./origin";

// Vite re-runs the server init hook in the same process after a server-module
// edit, sometimes before the previous run has finished. Module state is
// re-evaluated, so the previous dev runtime and the queue of reloads are kept here.
const devRuntime = Symbol.for("siluet.dev-runtime");
type DevRuntime = { close?: () => Promise<void>; turn: Promise<unknown> };
const host = process as typeof process & { [devRuntime]?: DevRuntime };

/**
 * Open the studio runtime. In dev, each call closes the runtime the previous
 * call opened, and calls run one at a time.
 */
export function initializeOwner(dev: boolean) {
	if (!dev) return openOwner(false);
	host[devRuntime] ??= { turn: Promise.resolve() };
	const state = host[devRuntime];
	const opened = state.turn.then(async () => {
		const previous = state.close;
		state.close = undefined;
		// Opening reports whether storage is still held.
		await previous?.().catch(() => console.error("Unable to close the previous studio runtime."));
		const runtime = await openOwner(true);
		// Register only a runtime that started; a failed start is already closed.
		state.close = runtime.close;
		return runtime;
	});
	state.turn = opened.catch(() => {});
	return opened;
}

async function openOwner(dev: boolean) {
	requireSupportedPlatform();
	const origin = studioOrigin(process.env, dev);
	const lifecycle: EventEmitter = process;
	if (!dev && !lifecycle.listenerCount("siluet:ready"))
		throw new Error("Start Siluet with bun run start.");
	const installation = await openRuntimeInstallation(ownerDirectory(dev));
	try {
		// Only this runtime holds the registry entry and Turso's lock, so leftovers
		// from an interrupted process can be reclaimed before any staging.
		const scratch = createScratchPool(installation);
		await scratch.reclaim();
		const stages = createStages(await scratch.scope("image"));
		// Owner changes that remove sessions also retire their bearers and staged copies, in
		// the storage turn that committed them.
		const bearers = createBearers();
		const ownerInstallation = {
			...installation,
			retireSessions(digests: ReadonlySet<string>) {
				bearers.retireSessions(digests);
				stages.retireSessions(digests);
			},
		};
		const shutdown = new AbortController();
		const cleaning = mediaCleaning(installation);
		const prepareMedia = createMediaPreparation(installation, {
			shutdown: shutdown.signal,
			readCleaning: cleaning.read,
		});
		const access = createOwnerAccess(ownerInstallation, Date.now, origin.origin, bearers);
		await access.security.initialize();
		const store = providerStore(installation);
		const providers = createProviderConnections(store, {
			poyo: checkPoyoConnection(),
			toapis: checkToapisConnection(),
		});
		// Tracking hands each completed result to automatic Save after its read commits (D9).
		const jobs = createJobTracking(installation, store, {
			onDelivery: (id, delivery) => autoSave.deliver(id, delivery),
		});
		const autoSave = createAutoSave(installation, {
			readForSave: jobs.readForSave,
			readability: store.jobReadability,
		});
		const videoAccess = createVideoAccess(installation, store);
		const videoQueue = await createVideoQueue(installation, videoAccess, jobs.dispatchVideo);
		const gallery = createGallery(installation);
		const queue = await createSubmissionQueue(installation, store.credential, jobs);
		const refusals = modelRefusals(installation);
		// File attempts carry this runtime's nonce, so a later runtime never sends for them.
		const nonce = crypto.randomUUID();
		const files = await createFileQueue(
			installation,
			nonce,
			stages,
			store.credential,
			fileDispatcher(installation, nonce, jobs.schedule),
			{ readCleaning: cleaning.read, shutdown: shutdown.signal },
		);
		let workers: Promise<void> | undefined;
		async function checkAccess() {
			await checkRequestSecurity(ownerInstallation);
			workers ??= (async () => {
				await cleanUnusedKeys(ownerInstallation);
				// This runtime alone holds the installation, so earlier attempts and scratch ended.
				await gallery.recover();
				await saveIntentStore(installation).clearAbandoned();
				// File attempts settle through their own phases before ordinary recovery.
				await fileAttemptStore(installation, nonce).recover(Date.now());
				await jobs.resume();
				autoSave.start();
			})().catch((e) => {
				workers = undefined;
				throw e;
			});
			await workers;
		}
		try {
			await checkAccess();
		} catch (e) {
			if (!(e instanceof AccessError)) throw e;
		}

		let rotation: ReturnType<typeof setTimeout> | undefined;
		async function announce() {
			if (await installation.hasOwner()) return;
			console.info("Setup URL:", new URL("/setup", origin).href);
			console.info("Claim token:", access.rotate());
			rotation = setTimeout(
				() => void announce().catch(() => console.error("Unable to verify studio storage.")),
				rotationMs,
			).unref();
		}
		const ready = () =>
			void announce().catch(() => console.error("Unable to verify studio storage."));
		let closing: Promise<void> | undefined;
		// Stop admission, let the held preparation and its stage write settle, then
		// remove staged copies before storage closes and the registry entry is released.
		function close() {
			closing ??= (async () => {
				try {
					clearTimeout(rotation);
					shutdown.abort();
					// File Queue stops admitting at once; claimed file and job dispatches drain together.
					await Promise.all([files.close(), jobs.close()]);
					await runtimeEntry(installation).preparation?.settled;
					await stages.close();
					// Active saves give their claims back before storage closes.
					await autoSave.close();
					await installation.close();
				} finally {
					// A later dev reload need not wait on this close again.
					const state = host[devRuntime];
					if (state?.close === close) state.close = undefined;
				}
			})();
			return closing;
		}
		/** Names the listener to the stop, from the first request that reaches it. */
		let watchServer: ReturnType<typeof closeRequestlessOnStop> = () => {};
		if (dev) {
			await announce();
		} else {
			watchServer = closeRequestlessOnStop(lifecycle);
			// The launcher emits siluet:stopping before the adapter drains requests.
			lifecycle.once("siluet:stopping", () => shutdown.abort());
			lifecycle.once("sveltekit:shutdown", () => {
				void close().catch(() => console.error("Unable to close studio storage."));
			});
			lifecycle.emit("siluet:ready", ready);
		}
		const browserSessions = createBrowserSessions({
			access,
			challenges: createChallenges(),
			origin,
			installation: installation.id,
			hasOwner: installation.hasOwner,
			checkAccess,
		});
		return {
			close,
			watchServer,
			browserSessions,
			stages,
			cleaning,
			prepareMedia,
			origin,
			checkAccess,
			videoAccess,
			videoQueue,
			jobs,
			gallery,
			autoSave,
			queue,
			refusals,
			files,
			access,
			providers,
			hasOwner: installation.hasOwner,
			installationId: installation.id,
		};
	} catch (e) {
		await installation.close();
		throw e;
	}
}
export type StudioRuntime = Awaited<ReturnType<typeof openOwner>>;
