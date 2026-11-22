import type { Installation } from "../../db/installation";
import { downloadImage } from "./download";
import { galleryStorage } from "./storage";
import { UnsupportedGalleryImage, verifyImage } from "./verify-image";

export function createGallery(
	installation: Installation,
	resultUrl: (id: string) => Promise<string | null>,
	download: (url: string) => Promise<Buffer> = downloadImage,
) {
	const storage = galleryStorage(installation);
	const pending = new Map<string, Promise<boolean>>();
	async function save(id: string) {
		try {
			if ((await storage.get(id))?.available) return true;
			const url = await resultUrl(id);
			if (!url) return false;
			const bytes = await download(url);
			return await storage.publish(id, bytes, await verifyImage(bytes));
		} catch (error) {
			if (error instanceof UnsupportedGalleryImage) await storage.markUnsupported(id);
			return false;
		}
	}
	return {
		recover: storage.recover,
		get: storage.get,
		list: storage.list,
		read: storage.read,
		remove: storage.remove,
		save(id: string) {
			const existing = pending.get(id);
			if (existing) return existing;
			const work = save(id).finally(() => pending.delete(id));
			pending.set(id, work);
			return work;
		},
	};
}
