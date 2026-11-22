import type { EventEmitter } from "node:events";
import { providerStore } from "../../db/provider-store";
import { openRuntimeInstallation, runtimeEntry } from "../../db/runtime-installation";
import { checkRequestSecurity, cleanUnusedKeys } from "../../db/security-state";
import { checkPoyoConnection } from "../../providers/poyo/connection";
import { checkToapisConnection } from "../../providers/toapis/connection";
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
import { ownerDirectory } from "./data-directory";
import { studioOrigin } from "./origin";

// Vite re-runs the server init hook in the same process after a server-module
// edit. Module state is re-evaluated, so the previous dev runtime is kept here.
const devRuntime = Symbol.for("siluet.dev-runtime");
const host = process as typeof process & { [devRuntime]?: () => Promise<void> };

export async function initializeOwner(dev: boolean) {
	const origin = studioOrigin(process.env, dev);
	const lifecycle: EventEmitter = process;
	if (!dev && !lifecycle.listenerCount("siluet:ready"))
		throw new Error("Start Siluet with bun run start.");
	if (dev) await host[devRuntime]?.();
	const installation = await openRuntimeInstallation(ownerDirectory(dev));
	try {
		// Only this runtime holds the registry entry and Turso's lock, so leftovers
		// from an interrupted process can be reclaimed before any staging.
		const scratch = createScratchPool(installation);
		await scratch.reclaim();
		const stages = createStages(await scratch.scope("image"));
		// Owner changes that remove sessions also retire their staged copies.
		const ownerInstallation = { ...installation, retireSessions: stages.retireSessions };
		const shutdown = new AbortController();
		const prepareMedia = createMediaPreparation(installation, { shutdown: shutdown.signal });
		const access = createOwnerAccess(ownerInstallation, Date.now, origin.origin);
		await access.security.initialize();
		const store = providerStore(installation);
		const providers = createProviderConnections(store, {
			poyo: checkPoyoConnection(),
			toapis: checkToapisConnection(),
		});
		const jobs = createJobTracking(installation, store);
		const videoAccess = createVideoAccess(installation, store);
		const videoQueue = await createVideoQueue(installation, videoAccess, jobs.dispatchVideo);
		const gallery = createGallery(installation, (id) => jobs.resultUrl(id));
		const queue = await createSubmissionQueue(installation, store.credential, jobs);
		let workers: Promise<void> | undefined;
		async function checkAccess() {
			await checkRequestSecurity(ownerInstallation);
			workers ??= (async () => {
				await cleanUnusedKeys(ownerInstallation);
				await gallery.recover();
				await jobs.resume();
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
				clearTimeout(rotation);
				shutdown.abort();
				jobs.close();
				await runtimeEntry(installation).preparation?.settled;
				await stages.close();
				await installation.close();
			})();
			return closing;
		}
		if (dev) {
			// Register only a runtime that started; a failed start is closed below.
			await announce();
			host[devRuntime] = close;
		} else {
			// The launcher emits siluet:stopping before the adapter drains requests.
			lifecycle.once("siluet:stopping", () => shutdown.abort());
			lifecycle.once("sveltekit:shutdown", () => {
				void close().catch(() => console.error("Unable to close studio storage."));
			});
			lifecycle.emit("siluet:ready", ready);
		}
		return {
			close,
			stages,
			prepareMedia,
			origin,
			checkAccess,
			videoAccess,
			videoQueue,
			jobs,
			gallery,
			queue,
			access,
			providers,
			hasOwner: installation.hasOwner,
			cookieName: `siluet_${installation.id}`,
		};
	} catch (e) {
		await installation.close();
		throw e;
	}
}
export type StudioRuntime = Awaited<ReturnType<typeof initializeOwner>>;
