import type { RuntimeInstallation } from "../../db/runtime-installation";
import { galleryStorage } from "./storage";

/** The owner's view of the local Gallery. Automatic Save (auto-save.ts) publishes into it. */
export function createGallery(installation: RuntimeInstallation) {
	const storage = galleryStorage(installation);
	return {
		/** Startup: finish interrupted removal, drop unindexed files and leftover video scratch. */
		recover: storage.recover,
		openVideo: storage.openVideo,
		get: storage.get,
		list: storage.list,
		read: storage.read,
		remove: storage.remove,
	};
}
