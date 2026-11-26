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
	await expect(page.getByText("This browser can't play this video.", { exact: false })).toHaveCount(
		0,
	);
}

/** Whether this engine decodes the H.264 fixture clips at all. */
export const playsH264 = (video: Locator) =>
	video.evaluate((v: HTMLVideoElement) => v.canPlayType('video/mp4; codecs="avc1.42E01E"') !== "");
