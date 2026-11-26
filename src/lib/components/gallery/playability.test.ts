import { afterEach, beforeEach, expect, jest, test } from "bun:test";
import { pictureWaitMs, playability } from "./playability";

/** The page's window: animation frames and, when present, intersection observers. */
class FakeWindow {
	turns = new Map<number, () => void>();
	#next = 0;
	observers: FakeObserver[] = [];
	IntersectionObserver?: typeof FakeObserver;
	constructor(observe: boolean) {
		const observers = this.observers;
		if (observe)
			this.IntersectionObserver = class extends FakeObserver {
				constructor(callback: ObserverCallback) {
					super(callback);
					observers.push(this);
				}
			};
	}
	requestAnimationFrame(callback: () => void) {
		this.#next++;
		this.turns.set(this.#next, callback);
		return this.#next;
	}
	cancelAnimationFrame(handle: number) {
		this.turns.delete(handle);
	}
	/** One rendering turn: the animation frame callbacks queued before it run. */
	turn() {
		const pending = [...this.turns.values()];
		this.turns.clear();
		for (const callback of pending) callback();
	}
}
type ObserverCallback = (entries: { isIntersecting: boolean }[]) => void;
class FakeObserver {
	observed: unknown[] = [];
	disconnected = false;
	constructor(readonly callback: ObserverCallback) {}
	observe(target: unknown) {
		this.observed.push(target);
	}
	disconnect() {
		this.disconnected = true;
	}
}
/** A page and `<video>` that the test drives: playback events, frames and visibility. */
class FakeDocument extends EventTarget {
	visibilityState: DocumentVisibilityState = "visible";
	defaultView: FakeWindow;
	constructor(observe: boolean) {
		super();
		this.defaultView = new FakeWindow(observe);
	}
	setVisible(visible: boolean) {
		this.visibilityState = visible ? "visible" : "hidden";
		this.dispatchEvent(new Event("visibilitychange"));
	}
}
class FakeVideo extends EventTarget {
	readonly NETWORK_EMPTY = 0;
	ownerDocument: FakeDocument;
	networkState = 0;
	currentSrc = "";
	error: { code: number } | null = null;
	paused = true;
	ended = false;
	frames = new Map<number, () => void>();
	#next = 0;
	constructor({ observe = false } = {}) {
		super();
		this.ownerDocument = new FakeDocument(observe);
	}
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
	/**
	 * Attach a source. The load algorithm pauses an element that already had one and clears its
	 * error, then fires `loadstart`; playback requested before any source carries on.
	 */
	load(src = "blob:clip") {
		if (this.networkState !== this.NETWORK_EMPTY) {
			this.paused = true;
			this.ended = false;
		}
		this.error = null;
		this.networkState = 2;
		this.currentSrc = src;
		this.emit("loadstart");
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
	/** Rendering turns pass with no frame presented. */
	turns(count = 2) {
		for (let i = 0; i < count; i++) this.ownerDocument.defaultView.turn();
	}
	/** The viewer scrolls into or out of the viewport. */
	scroll(onScreen: boolean) {
		for (const observer of this.ownerDocument.defaultView.observers)
			observer.callback([{ isIntersecting: onScreen }]);
	}
}

/** Every report, in order: true when the clip cannot play here. */
let reports: boolean[] = [];
let video: FakeVideo;
let detach: (() => void) | undefined;
function mount(element: FakeVideo = new FakeVideo(), src: string | null = "blob:clip") {
	detach?.();
	video = element;
	if (src !== null) video.load(src);
	detach = playability((unplayable) => reports.push(unplayable))(video as never) as
		| (() => void)
		| undefined;
}
/** Play past the wait with no frame: the note shows. */
function stall() {
	video.play();
	jest.advanceTimersByTime(pictureWaitMs);
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
	failed.load();
	failed.error = { code: 4 };
	reports = [];
	mount(failed, null);
	expect(reports).toEqual([true]);
});

test("playing with no frame for the wait says the clip cannot play, as WebKit plays the sound alone", () => {
	mount();
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
	video.present();
	video.play();
	jest.advanceTimersByTime(pictureWaitMs * 3);
	video.pause(true);
	video.turns();
	expect(reports).toEqual([]);
	mount();
	video.play();
	jest.advanceTimersByTime(pictureWaitMs / 2);
	video.present();
	jest.advanceTimersByTime(pictureWaitMs * 3);
	expect(reports).toEqual([]);
});

test("a frame after a slow start takes the note away again", () => {
	mount();
	stall();
	video.present();
	expect(reports).toEqual([true, false]);
});

test("a clip that ends with no frame cannot play once a rendering turn shows none", () => {
	mount();
	video.play();
	jest.advanceTimersByTime(pictureWaitMs / 2);
	video.pause(true);
	video.turns(1);
	expect(reports).toEqual([]);
	video.turns(1);
	expect(reports).toEqual([true]);
	jest.advanceTimersByTime(pictureWaitMs * 3);
	video.turns();
	expect(reports).toEqual([true]);
	mount();
	video.play();
	video.paused = true;
	video.ended = true;
	video.emit("ended");
	video.turns();
	expect(reports).toEqual([true, true]);
});

test("the last frame, composited as the clip ends, arrives before the note", () => {
	mount();
	video.play();
	jest.advanceTimersByTime(pictureWaitMs / 2);
	video.pause(true);
	video.turns(1);
	video.present();
	video.turns();
	jest.advanceTimersByTime(pictureWaitMs * 3);
	expect(reports).toEqual([]);
});

test("playing again, a new source or detaching drops the note deferred at the end", () => {
	mount();
	video.play();
	video.pause(true);
	video.play();
	video.turns();
	expect(reports).toEqual([]);
	jest.advanceTimersByTime(pictureWaitMs);
	expect(reports).toEqual([true]);
	reports = [];
	mount();
	video.play();
	video.pause(true);
	video.load("blob:next");
	video.turns();
	expect(reports).toEqual([]);
	mount();
	video.play();
	video.pause(true);
	detach?.();
	detach = undefined;
	expect(video.ownerDocument.defaultView.turns.size).toBe(0);
	expect(reports).toEqual([]);
});

test("without animation frames the end says so at once", () => {
	const plain = new FakeVideo();
	Object.defineProperty(plain.ownerDocument, "defaultView", { value: null });
	mount(plain);
	video.play();
	video.pause(true);
	expect(reports).toEqual([true]);
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
	video.turns();
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

test("only a viewer on screen is timed, and the wait starts over when it returns", () => {
	mount(new FakeVideo({ observe: true }));
	const [observer] = video.ownerDocument.defaultView.observers;
	expect(observer?.observed).toEqual([video]);
	// Until the observer first reports, the viewer counts as off screen.
	video.play();
	jest.advanceTimersByTime(pictureWaitMs * 3);
	video.pause(true);
	video.turns();
	expect(reports).toEqual([]);
	video.play();
	video.scroll(true);
	jest.advanceTimersByTime(pictureWaitMs - 1);
	video.scroll(false);
	jest.advanceTimersByTime(pictureWaitMs * 3);
	expect(reports).toEqual([]);
	video.scroll(true);
	jest.advanceTimersByTime(pictureWaitMs - 1);
	expect(reports).toEqual([]);
	jest.advanceTimersByTime(1);
	expect(reports).toEqual([true]);
	detach?.();
	detach = undefined;
	expect(observer?.disconnected).toBe(true);
});

test("playback before any source waits for it, and that source's frame clears the note", () => {
	mount(new FakeVideo(), null);
	video.play();
	jest.advanceTimersByTime(pictureWaitMs * 3);
	expect(reports).toEqual([]);
	video.load();
	expect(video.paused).toBe(false);
	jest.advanceTimersByTime(pictureWaitMs);
	expect(reports).toEqual([true]);
	video.present();
	expect(reports).toEqual([true, false]);
});

test("a new source needs its own frame and clears the note, as the viewer moves to another job", () => {
	mount();
	video.present();
	video.load("blob:second");
	stall();
	expect(reports).toEqual([true]);
	video.load("blob:third");
	expect(reports).toEqual([true, false]);
	jest.advanceTimersByTime(pictureWaitMs * 3);
	expect(reports).toEqual([true, false]);
	stall();
	expect(reports).toEqual([true, false, true]);
});

test("an error after a frame says the clip cannot play, and a later frame does not hide it", () => {
	mount();
	video.play();
	video.present();
	video.fail();
	expect(reports).toEqual([true]);
	reports = [];
	mount();
	stall();
	video.fail();
	video.present();
	expect(reports).toEqual([true]);
});

test("an error stops the wait and playback in the error state starts none", () => {
	mount();
	video.play();
	video.fail();
	expect(jest.getTimerCount()).toBe(0);
	video.paused = false;
	video.emit("play");
	video.ownerDocument.setVisible(false);
	video.ownerDocument.setVisible(true);
	expect(jest.getTimerCount()).toBe(0);
	jest.advanceTimersByTime(pictureWaitMs * 3);
	video.pause(true);
	video.turns();
	expect(reports).toEqual([true]);
	expect(jest.getTimerCount()).toBe(0);
	expect(video.ownerDocument.defaultView.turns.size).toBe(0);
});

test("an engine without frame callbacks reports only media errors", () => {
	const plain = new FakeVideo();
	Object.defineProperty(plain, "requestVideoFrameCallback", { value: undefined });
	mount(plain);
	video.play();
	jest.advanceTimersByTime(pictureWaitMs * 3);
	video.pause(true);
	video.turns();
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
	video.turns();
	expect(reports).toEqual([]);
	expect(video.frames.size).toBe(0);
});
