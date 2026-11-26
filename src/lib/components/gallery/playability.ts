import type { Attachment } from "svelte/attachments";

/** Visible playback this long with no frame on screen means the picture cannot play. */
export const pictureWaitMs = 3000;

/**
 * Report whether this browser can show a saved clip: `true` on a media error, or when visible
 * playback presents no frame within the wait or before the clip ends; `false` once a frame
 * shows after that. WebKit on macOS can play the sound of a clip whose H.264 it cannot decode
 * and raise no error, so only a presented frame shows the picture plays. Every saved clip has
 * one verified H.264 track. A browser without `requestVideoFrameCallback` reports errors only.
 */
export function playability(report: (unplayable: boolean) => void): Attachment<HTMLVideoElement> {
	return (video) => {
		const page = video.ownerDocument;
		const frames = typeof video.requestVideoFrameCallback === "function";
		let shown = false;
		let reported = false;
		let request: number | null = null;
		let timer: ReturnType<typeof setTimeout> | null = null;
		const tell = (unplayable: boolean) => {
			if (reported === unplayable) return;
			reported = unplayable;
			report(unplayable);
		};
		const stop = () => {
			if (timer !== null) clearTimeout(timer);
			timer = null;
		};
		/** Wait for the first frame of the current source. */
		const watch = () => {
			if (!frames) return;
			if (request !== null) video.cancelVideoFrameCallback(request);
			request = video.requestVideoFrameCallback(() => {
				request = null;
				shown = true;
				stop();
				if (!video.error) tell(false);
			});
		};
		/** Time visible playback until a frame shows. Hidden pages present no frames. */
		const time = () => {
			stop();
			if (!frames || shown || video.paused || page.visibilityState !== "visible") return;
			timer = setTimeout(() => {
				timer = null;
				tell(true);
			}, pictureWaitMs);
		};
		const onError = () => tell(true);
		// A new source is judged afresh: the viewer may now show another job.
		const onLoad = () => {
			shown = false;
			reported = false;
			watch();
			time();
		};
		// Browsers pause with `ended` set, then fire `ended`.
		const onPause = () => {
			if (timer !== null && video.ended) tell(true);
			stop();
		};
		video.addEventListener("error", onError);
		video.addEventListener("loadstart", onLoad);
		video.addEventListener("play", time);
		video.addEventListener("pause", onPause);
		video.addEventListener("ended", onPause);
		page.addEventListener("visibilitychange", time);
		// An error raised before the viewer attached leaves the element in its error state.
		if (video.error) tell(true);
		watch();
		time();
		return () => {
			stop();
			if (request !== null) video.cancelVideoFrameCallback(request);
			video.removeEventListener("error", onError);
			video.removeEventListener("loadstart", onLoad);
			video.removeEventListener("play", time);
			video.removeEventListener("pause", onPause);
			video.removeEventListener("ended", onPause);
			page.removeEventListener("visibilitychange", time);
		};
	};
}
