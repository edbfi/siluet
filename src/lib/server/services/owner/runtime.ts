import type { EventEmitter } from "node:events";
import { openInstallation } from "../../db/installation";
import { providerStore } from "../../db/provider-store";
import { checkRequestSecurity, cleanUnusedKeys } from "../../db/security-state";
import { checkPoyoConnection } from "../../providers/poyo/connection";
import { checkToapisConnection } from "../../providers/toapis/connection";
import { createGallery } from "../gallery/gallery";
import { createJobTracking } from "../jobs/tracking";
import { createProviderConnections } from "../providers/connections";
import { createVideoAccess } from "../providers/video-access";
import { createSubmissionQueue } from "../queue/submission";
import { createVideoQueue } from "../queue/video";
import { createOwnerAccess, rotationMs } from "./access";
import { AccessError } from "./access-error";
import { ownerDirectory } from "./data-directory";
import { studioOrigin } from "./origin";

export async function initializeOwner(dev: boolean) {
	const origin = studioOrigin(process.env, dev);
	const lifecycle: EventEmitter = process;
	if (!dev && !lifecycle.listenerCount("siluet:ready"))
		throw new Error("Start Siluet with bun run start.");
	const installation = await openInstallation(ownerDirectory(dev));
	try {
		const access = createOwnerAccess(installation, Date.now, origin.origin);
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
			await checkRequestSecurity(installation);
			workers ??= (async () => {
				await cleanUnusedKeys(installation);
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
		if (dev) await announce();
		else {
			lifecycle.once("sveltekit:shutdown", () => {
				clearTimeout(rotation);
				jobs.close();
				void installation.close().catch(() => console.error("Unable to close studio storage."));
			});
			lifecycle.emit("siluet:ready", ready);
		}
		return {
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
