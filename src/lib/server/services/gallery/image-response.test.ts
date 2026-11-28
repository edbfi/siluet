import { afterEach, beforeEach, expect, jest, test } from "bun:test";
import { imageHead, imageIdleMs, imageResponse, type OpenedImage } from "./image-response";

const url = new URL("http://studio.test/gallery/job/media");
let released: number;
function opened(size: number): OpenedImage {
	return {
		mime: "image/png",
		size,
		bytes: Buffer.alloc(size, 7),
		release: () => {
			released++;
		},
	};
}
/** Let the stream's pull run after each read, which re-arms the idle timer. */
async function flush() {
	for (let i = 0; i < 20; i++) await Promise.resolve();
}

beforeEach(() => {
	released = 0;
	jest.useFakeTimers();
});
afterEach(() => {
	jest.useRealTimers();
});

test("the body streams 64 KiB slices of the saved bytes and declares their length as X-Siluet-Length", async () => {
	jest.useRealTimers();
	const image = opened(200_000);
	const response = imageResponse(image, url, "siluet-image-job.png");
	// Bun drops a set Content-Length from a streamed body, so the tab reads this one instead.
	expect(response.headers.get("x-siluet-length")).toBe("200000");
	expect(response.headers.has("content-length")).toBe(false);
	expect(response.headers.get("content-type")).toBe("image/png");
	expect(response.headers.get("content-disposition")).toBe("inline");
	const reader = response.body?.getReader();
	const sizes: number[] = [];
	for (;;) {
		const chunk = await reader?.read();
		if (!chunk || chunk.done) break;
		sizes.push(chunk.value.byteLength);
	}
	expect(sizes).toEqual([65_536, 65_536, 65_536, 3_392]);
	expect([released, image.bytes]).toEqual([1, null]);
	const download = imageResponse(opened(1), new URL(`${url}?download=1`), "siluet-image-job.png");
	expect(download.headers.get("content-disposition")).toBe(
		'attachment; filename="siluet-image-job.png"',
	);
	await download.body?.cancel();
});

test("a paused reader's body errors once idle for 60 s, releasing its permit and buffer", async () => {
	expect(imageIdleMs).toBe(60_000);
	const image = opened(1024 * 1024);
	const reader = imageResponse(image, url, "a.png").body?.getReader();
	await reader?.read();
	await flush();
	jest.advanceTimersByTime(imageIdleMs - 1);
	await flush();
	expect(released).toBe(0);
	expect(image.bytes).not.toBeNull();
	jest.advanceTimersByTime(1);
	await flush();
	expect([released, image.bytes]).toEqual([1, null]);
	await expect(reader?.read()).rejects.toThrow();
});

test("a slow reader that keeps pulling finishes after more than 60 s in all", async () => {
	const image = opened(4 * 65_536);
	const reader = imageResponse(image, url, "a.png").body?.getReader();
	let total = 0;
	for (;;) {
		const chunk = await reader?.read();
		await flush();
		if (!chunk || chunk.done) break;
		total += chunk.value.byteLength;
		jest.advanceTimersByTime(imageIdleMs - 10_000);
		await flush();
		// The permit and buffer stay until the reader has taken the last slice.
		expect(released).toBe(total === image.size ? 1 : 0);
	}
	expect(total).toBe(4 * 65_536);
	expect([released, image.bytes]).toEqual([1, null]);
	// The idle timer is gone once the body finished.
	jest.advanceTimersByTime(imageIdleMs * 2);
	expect(released).toBe(1);
});

test("a cancelled body releases its permit and buffer once", async () => {
	const image = opened(1024);
	const response = imageResponse(image, url, "a.png");
	await response.body?.cancel();
	jest.advanceTimersByTime(imageIdleMs);
	await flush();
	expect([released, image.bytes]).toEqual([1, null]);
});

test("HEAD declares the saved length as Content-Length and no X-Siluet-Length", () => {
	jest.useRealTimers();
	const head = imageHead({ mime: "image/webp", size: 123_456 }, url, "a.webp");
	expect(head.headers.get("content-length")).toBe("123456");
	expect(head.headers.has("x-siluet-length")).toBe(false);
	expect(head.body).toBeNull();
});
