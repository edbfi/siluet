import type { RuntimeInstallation } from "../../db/runtime-installation";
import type { OpenedImage } from "./image-response";
import { createSlots } from "./slots";
import { galleryStorage } from "./storage";

/** Image buffers the Gallery route holds at once, from read to the end of each response (D5). */
const imageReads = 2;

/** The owner's view of the local Gallery. Automatic Save (auto-save.ts) publishes into it. */
export function createGallery(installation: RuntimeInstallation) {
	const storage = galleryStorage(installation);
	const reads = createSlots(imageReads);
	return {
		/** Startup: finish interrupted removal, drop unindexed files and leftover video scratch. */
		recover: storage.recover,
		openVideo: storage.openVideo,
		get: storage.get,
		list: storage.list,
		read: storage.read,
		headImage: storage.headImage,
		/**
		 * Read a saved image under one of the route's permits, waiting for one unless `signal`
		 * aborts; a request that aborts before or during the read releases its permit. The caller
		 * releases it once the response is done with the bytes.
		 */
		async openImage(id: string, signal: AbortSignal): Promise<OpenedImage | null> {
			const release = await reads.take(signal);
			try {
				signal.throwIfAborted();
				const image = await storage.read(id);
				signal.throwIfAborted();
				if (image)
					return { mime: image.mime, size: image.bytes.length, bytes: image.bytes, release };
			} catch (error) {
				release();
				throw error;
			}
			release();
			return null;
		},
		remove: storage.remove,
	};
}
