import type { Attachment } from "svelte/attachments";

/** Playback on screen this long with no frame presented means the picture cannot play. */
export const pictureWaitMs = 3000;

/**
 * Report whether this browser can show a saved clip: `true` on a media error, or when playback
 * on screen presents no frame within the wait or before the clip ends; `false` once a frame
 * shows after that, or a new source loads. WebKit on macOS can play the sound of a clip whose
 * H.264 it cannot decode and raise no error, so only a presented frame shows the picture plays.
 * Every saved clip has one verified H.264 track. A browser without `requestVideoFrameCallback`
 * reports errors only.
 */
export function playability(report: (unplayable: boolean) => void): Attachment<HTMLVideoElement> {
	return (video) => {
		const page = video.ownerDocument;
		const view = page.defaultView;
		const frames = typeof video.requestVideoFrameCallback === "function";
		let shown = false;
		let reported = false;
		let request: number | null = null;
		let timer: ReturnType<typeof setTimeout> | null = null;
		let turn: number | null = null;
		const tell = (unplayable: boolean) => {
			if (reported === unplayable) return;
			reported = unplayable;
			report(unplayable);
		};
		const stop = () => {
			if (timer !== null) clearTimeout(timer);
			timer = null;
		};
		const undefer = () => {
			if (turn !== null) view?.cancelAnimationFrame(turn);
			turn = null;
		};
		/**
		 * At the end, let a rendering turn pass before saying so: a frame composited up to the end
		 * delivers its callback first. Frame callbacks run before animation frames in a turn.
		 */
		const defer = () => {
			undefer();
			if (!view) return tell(true);
			turn = view.requestAnimationFrame(() => {
				turn = view.requestAnimationFrame(() => {
					turn = null;
					tell(true);
				});
			});
		};
		/** Wait for the first frame of the current source. */
		const watch = () => {
			if (!frames) return;
			if (request !== null) video.cancelVideoFrameCallback(request);
			request = video.requestVideoFrameCallback(() => {
				request = null;
				shown = true;
				stop();
				undefer();
				if (!video.error) tell(false);
			});
		};
		// Engines present no frames to a hidden page, and may skip them for a viewer off screen.
		const Observer = view?.IntersectionObserver;
		let onScreen = !Observer;
		const observer = Observer
			? new Observer(([entry]) => {
					onScreen = entry?.isIntersecting ?? false;
					time();
				})
			: null;
		const attached = () => video.networkState !== video.NETWORK_EMPTY && video.currentSrc !== "";
		/** Time playback of an attached source, on screen, until a frame shows. */
		function time() {
			stop();
			if (!frames || shown || video.error || video.paused || !attached()) return;
			if (page.visibilityState !== "visible" || !onScreen) return;
			timer = setTimeout(() => {
				timer = null;
				tell(true);
			}, pictureWaitMs);
		}
		const onError = () => {
			stop();
			undefer();
			tell(true);
		};
		const onPlay = () => {
			undefer();
			time();
		};
		// A new source is judged afresh: playback requested before it carries on into it.
		const onLoad = () => {
			shown = false;
			undefer();
			tell(false);
			watch();
			time();
		};
		// Browsers pause with `ended` set, then fire `ended`.
		const onPause = () => {
			if (timer !== null && video.ended) defer();
			stop();
		};
		video.addEventListener("error", onError);
		video.addEventListener("loadstart", onLoad);
		video.addEventListener("play", onPlay);
		video.addEventListener("pause", onPause);
		video.addEventListener("ended", onPause);
		page.addEventListener("visibilitychange", time);
		observer?.observe(video);
		// An error raised before the viewer attached leaves the element in its error state.
		if (video.error) tell(true);
		watch();
		time();
		return () => {
			stop();
			undefer();
			observer?.disconnect();
			if (request !== null) video.cancelVideoFrameCallback(request);
			video.removeEventListener("error", onError);
			video.removeEventListener("loadstart", onLoad);
			video.removeEventListener("play", onPlay);
			video.removeEventListener("pause", onPause);
			video.removeEventListener("ended", onPause);
			page.removeEventListener("visibilitychange", time);
		};
	};
}
