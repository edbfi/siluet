import type { RuntimeInstallation } from "../../db/runtime-installation";
import { downloadVideo, type VideoDelivery } from "../video-media/download";
import { UnsupportedVideoError } from "../video-media/errors";
import { videoSaveSlot } from "../video-media/save-slot";
import { verifyVideoFile } from "../video-media/verify-video";
import { downloadImage } from "./download";
import { galleryStorage } from "./storage";
import { UnsupportedGalleryImage, verifyImage } from "./verify-image";

const unsupported = {
	profile: "This completed video is outside the supported Gallery profile.",
	webm: "This completed video is WebM or Matroska. Gallery keeps MP4 files only.",
};
function refused(error: unknown) {
	if (error instanceof UnsupportedVideoError) return error;
	throw error;
}

export function createGallery(
	installation: RuntimeInstallation,
	resultUrl: (id: string) => Promise<string | null>,
	download: (url: string) => Promise<Buffer> = downloadImage,
	transferVideo = downloadVideo,
) {
	const slot = videoSaveSlot(installation);
	const videoSaves = new Map<string, Promise<string>>();
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
			if (error instanceof UnsupportedGalleryImage)
				await storage.markUnsupported(id).catch(() => {});
			return false;
		}
	}
	return {
		async recover() {
			await slot.recover();
			await storage.recover();
		},
		openVideo: storage.openVideo,
		saveVideo(id: string, result: () => Promise<VideoDelivery | null>) {
			const pending = videoSaves.get(id);
			if (pending) return pending;
			const work = (async () => {
				if ((await storage.get(id))?.available) return "Saved to Gallery.";
				// Another video waits here until the active Save finishes.
				return slot.hold(id, async ({ path, token }) => {
					if ((await storage.get(id))?.available) return "Saved to Gallery.";
					const delivery = await result();
					if (!delivery)
						return "The current task has no verified, unexpired video link. Check status and retry Save.";
					const bytes = await transferVideo(delivery, path).catch(refused);
					if (bytes instanceof UnsupportedVideoError) return unsupported[bytes.reason];
					const info = await verifyVideoFile(path).catch(refused);
					if (info instanceof UnsupportedVideoError) return unsupported[info.reason];
					return (await storage.publishVideo(id, path, token, { ...bytes, ...info }))
						? "Saved to Gallery."
						: "The video could not be saved.";
				});
			})()
				.catch(() => "The video download or local write failed. Retry Save on this job.")
				.finally(() => videoSaves.delete(id));
			videoSaves.set(id, work);
			return work;
		},
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
