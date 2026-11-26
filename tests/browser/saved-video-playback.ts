import { expect, type Locator, type Page } from "@playwright/test";

/**
 * With the saved clip's native controls focused: seek by keyboard while paused, before any
 * playback, then play with Space to the end. No "can't play" note may appear.
 */
export async function seekThenPlay(page: Page, video: Locator) {
	expect(await video.evaluate((v: HTMLVideoElement) => v.autoplay)).toBe(false);
	if (!(await playsH264(video))) {
		// Playwright's Linux Firefox has no H.264 decoder: Gallery says so and keeps Download.
		await expect(
			page.getByText("This browser can't play this video.", { exact: false }),
		).toBeVisible();
		return false;
	}
	await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.readyState)).toBeGreaterThan(0);
	await watchNote(video);
	await video.evaluate((v: HTMLVideoElement) => {
		v.dataset.seeked = "0";
		v.addEventListener("seeked", () => {
			v.dataset.seeked = String(Number(v.dataset.seeked) + 1);
		});
	});
	await video.focus();
	await video.press("ArrowRight");
	await expect
		.poll(() =>
			video.evaluate((v: HTMLVideoElement) => ({
				seeked: Number(v.dataset.seeked) > 0,
				moved: v.currentTime > 0,
				paused: v.paused,
			})),
		)
		.toEqual({ seeked: true, moved: true, paused: true });
	await video.press("Space");
	await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.paused)).toBe(false);
	await expect
		.poll(() => video.evaluate((v: HTMLVideoElement) => v.played.length && v.played.end(0)))
		.toBeGreaterThan(0);
	// Gallery says a clip cannot play when it ends with no frame shown, so play it to the end.
	await expect
		.poll(() => video.evaluate((v: HTMLVideoElement) => v.ended), { timeout: 15_000 })
		.toBe(true);
	// Gallery decides at the end only after two rendering turns, so wait them out first.
	await video.evaluate(
		() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
	);
	expect(await framesShown(video)).toBeGreaterThan(0);
	expect(await noteShown(video)).toBe(false);
}

/**
 * Record whether Gallery's status beside the player ever holds text from now on, and every
 * frame the player presents to the page.
 */
export const watchNote = (video: Locator) =>
	video.evaluate((v: HTMLVideoElement) => {
		const status = v.nextElementSibling;
		if (status?.getAttribute("role") !== "status") throw new Error("No status after the player");
		v.dataset.noteShown = String(Boolean(status.textContent?.trim()));
		new MutationObserver(() => {
			if (status.textContent?.trim()) v.dataset.noteShown = "true";
		}).observe(status, { childList: true, characterData: true, subtree: true });
		v.dataset.frames = "0";
		const count = () => {
			v.dataset.frames = String(Number(v.dataset.frames) + 1);
			v.requestVideoFrameCallback(count);
		};
		if (typeof v.requestVideoFrameCallback === "function") v.requestVideoFrameCallback(count);
	});
/** Whether the status beside the player held text since `watchNote`. */
export const noteShown = (video: Locator) =>
	video.evaluate((v: HTMLVideoElement) => v.dataset.noteShown !== "false");
/** Frames the player presented since `watchNote`. */
export const framesShown = (video: Locator) =>
	video.evaluate((v: HTMLVideoElement) => Number(v.dataset.frames));

/** Ask the player to play without waiting on a promise an engine may leave pending. */
export const startPlayback = (video: Locator) =>
	video.evaluate((v: HTMLVideoElement) => {
		v.play().catch((error: Error) => {
			v.dataset.playRejected = `${error.name}: ${error.message}`;
		});
	});

/** The player's media state, for a failure message. */
export const playerState = (video: Locator) =>
	video.evaluate((v: HTMLVideoElement) =>
		JSON.stringify({
			error: v.error?.code ?? null,
			playRejected: v.dataset.playRejected ?? null,
			networkState: v.networkState,
			readyState: v.readyState,
			paused: v.paused,
			ended: v.ended,
			currentTime: v.currentTime,
			duration: v.duration,
			size: [v.videoWidth, v.videoHeight],
			frameCallbacks: typeof v.requestVideoFrameCallback === "function",
			frames: v.dataset.frames ?? null,
			noteShown: v.dataset.noteShown ?? null,
			canPlay: v.canPlayType('video/mp4; codecs="avc1.42E01E, mp4a.40.2"'),
		}),
	);

/** Whether this engine decodes the H.264 fixture clips at all. */
export const playsH264 = (video: Locator) =>
	video.evaluate((v: HTMLVideoElement) => v.canPlayType('video/mp4; codecs="avc1.42E01E"') !== "");
