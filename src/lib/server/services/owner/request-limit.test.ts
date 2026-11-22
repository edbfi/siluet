import { expect, test } from "bun:test";
import { ordinaryRequest } from "./request-limit";

test("ordinary POSTs retain the 512 KiB limit for streamed and declared bodies", async () => {
	const stream = (size: number) =>
		new Request("http://localhost/", {
			method: "POST",
			body: new ReadableStream({
				start(c) {
					c.enqueue(new Uint8Array(512 * 1024));
					c.enqueue(new Uint8Array(size));
					c.close();
				},
			}),
		});
	expect(await ordinaryRequest(stream(1))).toBeNull();
	expect((await (await ordinaryRequest(stream(0)))?.arrayBuffer())?.byteLength).toBe(512 * 1024);
	expect(
		await ordinaryRequest(
			new Request("http://localhost/", { method: "POST", headers: { "content-length": "524289" } }),
		),
	).toBeNull();
});

test("chunked 600 KiB POST to an ordinary route → 413", async () => {
	let cancelled = false;
	const request = new Request("http://localhost/settings", {
		method: "POST",
		body: new ReadableStream({
			pull(c) {
				c.enqueue(new Uint8Array(100 * 1024));
			},
			cancel() {
				cancelled = true;
			},
		}),
	});
	expect(request.headers.get("content-length")).toBeNull();
	expect(await ordinaryRequest(request)).toBeNull();
	expect(cancelled).toBeTrue();
});
