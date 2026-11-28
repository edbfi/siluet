import { expect, jest, spyOn, test } from "bun:test";
import { g13Bounds } from "../../../../../tests/fixtures/gallery-bounds";
import { downloadImage, encodedLimit, imageDeadlines } from "./download";

const source = "https://images.example.org/image?signature=private";
const resolve = async () => "93.184.216.34";

test("resolves each origin, then connects only to the vetted IP with its TLS name", async () => {
	const hosts: string[] = [];
	const requests: string[] = [];
	const bytes = await downloadImage(source, {
		resolve: async (host) => {
			hosts.push(host);
			return host === "images.example.org" ? "93.184.216.34" : "2606:4700:4700::1111";
		},
		request: async (url, init) => {
			requests.push(url.href);
			expect(init.headers).toEqual({
				host: hosts.at(-1) ?? "",
				"accept-encoding": "identity",
			});
			expect(init.proxy).toBe(false);
			expect(init.redirect).toBe("manual");
			expect(init.credentials).toBe("omit");
			expect(init.tls?.serverName).toBe(hosts.at(-1));
			expect(init.tls?.rejectUnauthorized).toBe(true);
			return requests.length === 1
				? Response.redirect("https://cdn.example.org/finished", 302)
				: new Response("data");
		},
	});
	expect(requests).toEqual([
		"https://93.184.216.34/image?signature=private",
		"https://[2606:4700:4700::1111]/finished",
	]);
	expect(hosts).toEqual(["images.example.org", "cdn.example.org"]);
	expect(bytes.toString()).toBe("data");
});

test("rejects nonpublic resolved addresses before issuing a request", async () => {
	for (const address of [
		"127.0.0.1",
		"192.168.1.1",
		"169.254.1.1",
		"192.88.99.1",
		"::ffff:127.0.0.1",
		"fe80::1",
		"::1",
		"invalid",
	]) {
		let calls = 0;
		await expect(
			downloadImage(source, {
				resolve: async () => address,
				request: async () => {
					calls++;
					return new Response("data");
				},
			}),
		).rejects.toThrow();
		expect(calls).toBe(0);
	}
});

test("redirects cannot select loopback, embedded credentials or plain HTTP", async () => {
	for (const location of [
		"https://127.0.0.1/",
		"https://a:b@cdn.example.org/x",
		"http://cdn.example.org/y",
	]) {
		let calls = 0;
		await expect(
			downloadImage(source, {
				resolve,
				request: async () => {
					calls++;
					return Response.redirect(location);
				},
			}),
		).rejects.toThrow();
		expect(calls).toBe(1);
	}
});

test("rejects an expired result, partial response, unsafe length, or chunked overflow", async () => {
	for (const response of [
		new Response("expired", { status: 403 }),
		new Response("partial", { status: 206 }),
		new Response("short", { headers: { "content-length": "6" } }),
		new Response("compressed", { headers: { "content-encoding": "gzip" } }),
		new Response("large", { headers: { "content-length": String(encodedLimit + 1) } }),
		new Response(
			new ReadableStream({
				pull(controller) {
					controller.enqueue(new Uint8Array(1024 * 1024));
				},
			}),
		),
	]) {
		await expect(
			downloadImage(source, { resolve, request: async () => response }),
		).rejects.toThrow();
	}
});

/** A body of `size` bytes in 1 MiB chunks, declaring `declared` (none when null). */
function body(size: number, declared: number | null = size) {
	let sent = 0;
	const chunk = new Uint8Array(1024 * 1024).fill(7);
	const stream = new ReadableStream<Uint8Array>({
		pull(controller) {
			const length = Math.min(chunk.length, size - sent);
			if (length <= 0) return controller.close();
			controller.enqueue(chunk.subarray(0, length));
			sent += length;
		},
	});
	return new Response(stream, {
		headers: declared === null ? {} : { "content-length": String(declared) },
	});
}

test("the encoded limit is 80 MiB: exactly that much is read, one byte more fails", async () => {
	expect(encodedLimit).toBe(g13Bounds.bytes);
	for (const declared of [encodedLimit, null]) {
		const bytes = await downloadImage(source, {
			resolve,
			request: async () => body(encodedLimit, declared),
		});
		expect(bytes.length).toBe(encodedLimit);
	}
	for (const response of [
		() => body(encodedLimit + 1, null),
		() => body(encodedLimit + 1, encodedLimit + 1),
		() => body(0, encodedLimit + 1),
	]) {
		const error = await downloadImage(source, { resolve, request: async () => response() }).catch(
			(reason: unknown) => reason,
		);
		// A failed download, not a hold: D9 retries it.
		expect(error).toBeInstanceOf(Error);
		expect(error).not.toHaveProperty("reason");
	}
});

test("a valid declared length pre-sizes the buffer the body is read into", async () => {
	const allocate = spyOn(Buffer, "allocUnsafe");
	try {
		await downloadImage(source, { resolve, request: async () => body(3 * 1024 * 1024) });
		expect(allocate.mock.calls).toEqual([[3 * 1024 * 1024]]);
		const undeclared = await downloadImage(source, {
			resolve,
			request: async () => body(1024, null),
		});
		expect(undeclared.length).toBe(1024);
		expect(allocate).toHaveBeenCalledTimes(1);
	} finally {
		allocate.mockRestore();
	}
});

test("one deadline covers DNS and redirects, and late DNS cannot initiate a connection", async () => {
	jest.useFakeTimers();
	try {
		const dns = Promise.withResolvers<string>();
		let requests = 0;
		const transfer = downloadImage(source, {
			resolve: () => dns.promise,
			request: async () => {
				requests++;
				return new Response("data");
			},
		});
		jest.advanceTimersByTime(30_000);
		await expect(transfer).rejects.toThrow();
		dns.resolve("93.184.216.34");
		await Promise.resolve();
		expect(requests).toBe(0);
	} finally {
		jest.useRealTimers();
	}
});

const MiB = 1024 * 1024;
/** Let promise continuations run between fake-timer steps. */
async function flush() {
	for (let i = 0; i < 20; i++) await Promise.resolve();
}
/** Advance fake time by `ms` in 100 ms steps, flushing continuations after each. */
async function advance(ms: number) {
	for (let elapsed = 0; elapsed < ms; elapsed += 100) {
		jest.advanceTimersByTime(Math.min(100, ms - elapsed));
		await flush();
	}
}
/** `size` bytes in 1 MiB chunks, the first at once and each next after `gapMs`; then a stall. */
function paced(size: number, gapMs: number, stallAfter = Number.POSITIVE_INFINITY) {
	const chunk = new Uint8Array(MiB);
	let sent = 0;
	return new Response(
		new ReadableStream<Uint8Array>({
			async pull(controller) {
				if (sent >= size) return controller.close();
				if (sent >= stallAfter) return new Promise<void>(() => {});
				if (sent > 0) await new Promise((resolve) => setTimeout(resolve, gapMs));
				controller.enqueue(chunk.subarray(0, Math.min(MiB, size - sent)));
				sent += MiB;
			},
		}),
		{ headers: { "content-length": String(size) } },
	);
}
const settled = (promise: Promise<unknown>) => {
	const state = { done: false, error: undefined as unknown };
	promise.then(
		() => {
			state.done = true;
		},
		(error: unknown) => {
			state.done = true;
			state.error = error;
		},
	);
	return state;
};

test("the transfer allows 30 s for headers and 75 s in all, as video's two stages do", () => {
	expect(imageDeadlines).toEqual({ headersMs: 30_000, totalMs: 75_000 });
	// Today's floor of 32 MiB in 30 s carries over to 80 MiB.
	expect(encodedLimit / imageDeadlines.totalMs).toBeCloseTo((32 * MiB) / 30_000);
});

test("a transfer without headers 30 s after it starts fails", async () => {
	jest.useFakeTimers();
	try {
		const transfer = downloadImage(source, {
			resolve,
			request: () => new Promise<Response>(() => {}),
		});
		const state = settled(transfer);
		await advance(29_900);
		expect(state.done).toBe(false);
		await advance(100);
		expect(state.done).toBe(true);
		expect(state.error).toBeInstanceOf(Error);
		expect(state.error).not.toHaveProperty("reason");
	} finally {
		jest.useRealTimers();
	}
});

test("an 80 MiB body at the floor rate completes within the total deadline", async () => {
	jest.useFakeTimers();
	try {
		// 1 MiB every 937.5 ms is 32 MiB in 30 s; the last of 80 chunks arrives at 74.06 s.
		const transfer = downloadImage(source, {
			resolve,
			request: async () => paced(encodedLimit, 937.5),
		});
		const state = settled(transfer);
		await advance(74_000);
		expect(state.done).toBe(false);
		await advance(200);
		expect(state).toEqual({ done: true, error: undefined });
		expect((await transfer).length).toBe(encodedLimit);
	} finally {
		jest.useRealTimers();
	}
});

test("a body stalled past 75 s in all fails, and shutdown still aborts at once", async () => {
	jest.useFakeTimers();
	try {
		const stalled = settled(
			downloadImage(source, { resolve, request: async () => paced(encodedLimit, 100, 4 * MiB) }),
		);
		await advance(74_900);
		expect(stalled.done).toBe(false);
		await advance(100);
		expect(stalled.done).toBe(true);
		expect(stalled.error).toBeInstanceOf(Error);

		const shutdown = new AbortController();
		const stopped = settled(
			downloadImage(
				source,
				{ resolve, request: async () => paced(encodedLimit, 100, 4 * MiB) },
				shutdown.signal,
			),
		);
		await advance(1_000);
		shutdown.abort(new Error("Siluet is stopping."));
		await flush();
		expect(stopped).toMatchObject({ done: true, error: { message: "Siluet is stopping." } });
	} finally {
		jest.useRealTimers();
	}
});
