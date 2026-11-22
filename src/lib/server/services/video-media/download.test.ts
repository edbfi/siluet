import { expect, test } from "bun:test";
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
