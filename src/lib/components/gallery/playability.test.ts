import { afterEach, beforeEach, expect, jest, test } from "bun:test";
import { pictureWaitMs, playability } from "./playability";

/** A page and `<video>` that the test drives: playback events, frames and visibility. */
class FakeDocument extends EventTarget {
	visibilityState: DocumentVisibilityState = "visible";
	setVisible(visible: boolean) {
		this.visibilityState = visible ? "visible" : "hidden";
		this.dispatchEvent(new Event("visibilitychange"));
	}
}
class FakeVideo extends EventTarget {
	ownerDocument = new FakeDocument();
	error: { code: number } | null = null;
	paused = true;
	ended = false;
	frames = new Map<number, () => void>();
	#next = 0;
	requestVideoFrameCallback(callback: () => void) {
		this.#next++;
		this.frames.set(this.#next, callback);
		return this.#next;
	}
	cancelVideoFrameCallback(handle: number) {
		this.frames.delete(handle);
	}
	emit(type: string) {
		this.dispatchEvent(new Event(type));
	}
	fail() {
		this.error = { code: 3 };
		this.emit("error");
	}
	play() {
		this.paused = false;
		this.ended = false;
		this.emit("play");
	}
	/** Pause, or reach the end: browsers fire `pause` with `ended` already true, then `ended`. */
	pause(ended = false) {
		this.paused = true;
		this.ended = ended;
		this.emit("pause");
		if (ended) this.emit("ended");
	}
	/** The engine presents a frame to the page. */
	present() {
		const pending = [...this.frames.values()];
		this.frames.clear();
		for (const callback of pending) callback();
	}
}

/** Every report, in order: true when the clip cannot play here. */
let reports: boolean[] = [];
let video: FakeVideo;
let detach: (() => void) | undefined;
function mount(element: FakeVideo = new FakeVideo()) {
	detach?.();
	video = element;
	detach = playability((unplayable) => reports.push(unplayable))(video as never) as
		| (() => void)
		| undefined;
}
beforeEach(() => {
	jest.useFakeTimers();
	reports = [];
});
afterEach(() => {
	detach?.();
	detach = undefined;
	jest.useRealTimers();
});

test("a media error says the clip cannot play, including one raised before the viewer attached", () => {
	mount();
	video.fail();
	expect(reports).toEqual([true]);
	const failed = new FakeVideo();
	failed.error = { code: 4 };
	reports = [];
	mount(failed);
	expect(reports).toEqual([true]);
});

test("playing with no frame for the wait says the clip cannot play, as WebKit plays the sound alone", () => {
	mount();
	video.emit("loadstart");
	video.play();
	jest.advanceTimersByTime(pictureWaitMs - 1);
	expect(reports).toEqual([]);
	jest.advanceTimersByTime(1);
	expect(reports).toEqual([true]);
	jest.advanceTimersByTime(pictureWaitMs * 3);
	expect(reports).toEqual([true]);
});

test("a presented frame keeps the note away, before or during playback", () => {
	mount();
	video.emit("loadstart");
	video.present();
	video.play();
	jest.advanceTimersByTime(pictureWaitMs * 3);
	video.pause(true);
	expect(reports).toEqual([]);
	mount();
	video.emit("loadstart");
	video.play();
	jest.advanceTimersByTime(pictureWaitMs / 2);
	video.present();
	jest.advanceTimersByTime(pictureWaitMs * 3);
	expect(reports).toEqual([]);
});

test("a frame after a slow start takes the note away again", () => {
	mount();
	video.play();
	jest.advanceTimersByTime(pictureWaitMs);
	video.present();
	expect(reports).toEqual([true, false]);
});

test("a clip that ends before the wait with no frame cannot play", () => {
	mount();
	video.play();
	jest.advanceTimersByTime(pictureWaitMs / 2);
	video.pause(true);
	expect(reports).toEqual([true]);
	jest.advanceTimersByTime(pictureWaitMs * 3);
	expect(reports).toEqual([true]);
	mount();
	video.play();
	video.paused = true;
	video.ended = true;
	video.emit("ended");
	expect(reports).toEqual([true, true]);
});

test("pausing stops the wait and playing again starts it over", () => {
	mount();
	video.play();
	jest.advanceTimersByTime(pictureWaitMs - 1);
	video.pause();
	jest.advanceTimersByTime(pictureWaitMs * 3);
	expect(reports).toEqual([]);
	video.play();
	jest.advanceTimersByTime(pictureWaitMs - 1);
	expect(reports).toEqual([]);
	jest.advanceTimersByTime(1);
	expect(reports).toEqual([true]);
});

test("a hidden page presents no frames, so only visible playback counts", () => {
	mount();
	video.ownerDocument.setVisible(false);
	video.play();
	jest.advanceTimersByTime(pictureWaitMs * 3);
	video.pause(true);
	expect(reports).toEqual([]);
	video.play();
	jest.advanceTimersByTime(pictureWaitMs / 2);
	video.ownerDocument.setVisible(true);
	jest.advanceTimersByTime(pictureWaitMs - 1);
	expect(reports).toEqual([]);
	video.ownerDocument.setVisible(false);
	jest.advanceTimersByTime(pictureWaitMs * 3);
	expect(reports).toEqual([]);
	video.ownerDocument.setVisible(true);
	jest.advanceTimersByTime(pictureWaitMs);
	expect(reports).toEqual([true]);
});

test("a new source needs its own frame and reports afresh, as the viewer moves to another job", () => {
	mount();
	video.emit("loadstart");
	video.present();
	video.emit("loadstart");
	video.play();
	jest.advanceTimersByTime(pictureWaitMs);
	expect(reports).toEqual([true]);
	video.emit("loadstart");
	jest.advanceTimersByTime(pictureWaitMs);
	expect(reports).toEqual([true, true]);
});

test("an engine without frame callbacks reports only media errors", () => {
	const plain = new FakeVideo();
	Object.defineProperty(plain, "requestVideoFrameCallback", { value: undefined });
	mount(plain);
	video.play();
	jest.advanceTimersByTime(pictureWaitMs * 3);
	video.pause(true);
	expect(reports).toEqual([]);
	video.fail();
	expect(reports).toEqual([true]);
});

test("a detached viewer reports nothing and cancels its frame request", () => {
	mount();
	video.play();
	detach?.();
	detach = undefined;
	jest.advanceTimersByTime(pictureWaitMs * 3);
	video.fail();
	video.pause(true);
	expect(reports).toEqual([]);
	expect(video.frames.size).toBe(0);
});
