import { expect, spyOn, test } from "bun:test";
import { lstat, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { downloadVideo } from "./download";
import { videoByteLimit } from "./mp4";

const source = { url: "https://93.184.216.34/primary", fallback: "https://93.184.216.34/fallback" };
test("only pre-body availability failures can use a second delivery URL", async () => {
	const dir = await mkdtemp(join(tmpdir(), "video-download-"));
	try {
		for (const [response, allowed] of [
			[() => new Response(null, { status: 503 }), true],
			[
				() => {
					throw new Error("fixture connection closed");
				},
				true,
			],
			[() => Response.redirect("https://127.0.0.1/"), false],
			[() => new Response("part", { status: 206 }), false],
			[() => new Response("part", { headers: { "content-range": "bytes 0-3/6" } }), false],
			[() => new Response("encoded", { headers: { "content-encoding": "gzip" } }), false],
			[() => new Response("short", { headers: { "content-length": "7" } }), false],
			[
				() => new Response("large", { headers: { "content-length": String(videoByteLimit + 1) } }),
				false,
			],
			[
				() =>
					new Response(
						new ReadableStream({
							pull(c) {
								c.error(new Error("interrupted body"));
							},
						}),
					),
				false,
			],
		] as const) {
			const path = join(dir, crypto.randomUUID());
			const calls: string[] = [];
			const work = downloadVideo(source, path, {
				resolve: async () => source.url,
				request: async (url, init) => {
					calls.push(url.pathname);
					expect(init.credentials).toBe("omit");
					expect(new Headers(init.headers).get("authorization")).toBeNull();
					return url.pathname === "/primary" ? response() : new Response("fixture");
				},
			});
			if (allowed) {
				expect(await work).toMatchObject({ size: 7 });
				expect(await readFile(path, "utf8")).toBe("fixture");
				expect((await lstat(path)).mode & 0o777).toBe(0o600);
			} else await expect(work).rejects.toThrow();
			expect(calls).toEqual(allowed ? ["/primary", "/fallback"] : ["/primary"]);
		}
		let contacted = 0;
		const work = downloadVideo({ ...source, url: "https://127.0.0.1/private" }, join(dir, "none"), {
			resolve: async () => "",
			request: async () => {
				contacted++;
				return new Response("none");
			},
		});
		await expect(work).rejects.toThrow();
		expect(contacted).toBe(0);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("a primary body can finish after its header deadline within the total budget", async () => {
	const dir = await mkdtemp(join(tmpdir(), "video-budget-"));
	const primary = new AbortController();
	const budget = new AbortController();
	const deadlines = spyOn(AbortSignal, "timeout").mockImplementation((ms) =>
		ms === 30_000 ? primary.signal : budget.signal,
	);
	try {
		const ready = Promise.withResolvers<void>();
		let body!: ReadableStreamDefaultController<Uint8Array>;
		let requestSignal: AbortSignal | null | undefined;
		const file = join(dir, "video");
		const saved = downloadVideo(source, file, {
			resolve: async () => "",
			request: async (url, init) => {
				expect(url.pathname).toBe("/primary");
				requestSignal = init.signal;
				return new Response(
					new ReadableStream<Uint8Array>(
						{
							start(controller) {
								body = controller;
							},
							pull() {
								ready.resolve();
							},
						},
						{ highWaterMark: 0 },
					),
				);
			},
		});
		await ready.promise;
		primary.abort();
		body.enqueue(new Uint8Array([1, 2, 3]));
		body.close();
		expect(await saved).toMatchObject({ size: 3 });
		expect(requestSignal?.aborted).toBe(false);
	} finally {
		deadlines.mockRestore();
		await rm(dir, { recursive: true, force: true });
	}
});

test.each(["header deadline", "total budget"])(
	"a stalled primary request respects the %s",
	async (expires) => {
		const dir = await mkdtemp(join(tmpdir(), "video-deadline-"));
		const primary = new AbortController();
		const budget = new AbortController();
		const deadlines = spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
			if (ms === 30_000) return primary.signal;
			expect(ms).toBe(60_000);
			return budget.signal;
		});
		const calls: string[] = [];
		const waiting = Promise.withResolvers<void>();
		const primaryResponse = Promise.withResolvers<Response>();
		let primaryAborted = false;
		try {
			const file = join(dir, "video");
			const saved = downloadVideo(source, file, {
				resolve: async () => "",
				request: async (url, init) => {
					calls.push(url.pathname);
					if (url.pathname === "/fallback") return new Response("fallback");
					init.signal?.addEventListener(
						"abort",
						() => {
							primaryAborted = true;
							primaryResponse.reject(new Error("primary request aborted"));
						},
						{ once: true },
					);
					waiting.resolve();
					return primaryResponse.promise;
				},
			});
			await waiting.promise;
			const expired = expires === "header deadline" ? primary : budget;
			expired.abort();
			// Settle a request that missed cancellation so a regression fails immediately.
			primaryResponse.resolve(new Response("late primary"));
			if (expires === "header deadline") {
				expect(await saved).toMatchObject({ size: 8 });
				expect(await readFile(file, "utf8")).toBe("fallback");
				expect(calls).toEqual(["/primary", "/fallback"]);
			} else {
				await expect(saved).rejects.toThrow();
				expect(calls).toEqual(["/primary"]);
			}
			expect(primaryAborted).toBe(true);
		} finally {
			budget.abort();
			deadlines.mockRestore();
			await rm(dir, { recursive: true, force: true });
		}
	},
);
