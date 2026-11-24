import { expect, test } from "bun:test";
import { filePost, pinFilePost } from "./file-post";

test("binds a fixed POST to public TLS with no proxy and a bounded response", async () => {
	const endpoint = "https://api.poyo.ai/submit";
	let calls = 0;
	const read = filePost(
		endpoint,
		60_000,
		async () => "93.184.216.34",
		async (target, init) => {
			calls++;
			expect(target.hostname).toBe("93.184.216.34");
			expect(init.proxy).toBe(false);
			expect(init.redirect).toBe("error");
			expect(init.tls).toEqual({ serverName: "api.poyo.ai", rejectUnauthorized: true });
			return new Response(new Uint8Array(65537));
		},
	);
	await expect(read(endpoint, { method: "POST" })).rejects.toThrow();
	await expect(read("https://alternative.net/path", { method: "POST" })).rejects.toThrow();
	await expect(
		filePost(
			endpoint,
			60_000,
			async () => "127.0.0.1",
			async () => {
				calls++;
				return new Response();
			},
		)(endpoint, { method: "POST" }),
	).rejects.toThrow();
	expect(calls).toBe(1);
});

test("the deadline covers a stalled response body", async () => {
	const endpoint = "https://api.toapis.com/submit";
	const read = filePost(
		endpoint,
		30,
		async () => "93.184.216.34",
		async () =>
			new Response(
				new ReadableStream({
					start(c) {
						c.enqueue(new Uint8Array([123]));
					},
				}),
			),
	);
	await expect(read(endpoint, { method: "POST" })).rejects.toThrow();
});

test("a redirect yields no second POST", async () => {
	const endpoint = "https://api.poyo.ai/submit";
	const sent: URL[] = [];
	const read = filePost(
		endpoint,
		60_000,
		async () => "93.184.216.34",
		async (target) => {
			sent.push(target);
			return new Response("redirect", {
				status: 307,
				headers: { location: "https://other.example.org/upload" },
			});
		},
	);
	await expect(
		read(endpoint, { method: "POST", headers: { authorization: "Bearer fixture" } }),
	).rejects.toThrow();
	expect(sent.map((url) => url.host)).toEqual(["93.184.216.34"]);
});

test.each(["limited", null])(
	"preserves pacing evidence from a single 429 POST with body %p",
	async (body) => {
		const endpoint = "https://api.poyo.ai/submit";
		const sent: string[] = [];
		const pacing = {
			"retry-after": "60",
			"x-ratelimit-category": "submit",
			"x-ratelimit-remaining": "0",
			"x-ratelimit-reset": "1700000060",
		};
		const read = filePost(
			endpoint,
			1000,
			async () => "93.184.216.34",
			async (target, init) => {
				sent.push(target.href);
				expect(init.method).toBe("POST");
				return new Response(body, {
					status: 429,
					headers: { ...pacing, "set-cookie": "private=fixture" },
				});
			},
		);
		const response = await read(endpoint, { method: "POST" });
		expect(response.status).toBe(429);
		expect(Object.fromEntries(response.headers)).toEqual(pacing);
		expect(await response.text()).toBe(body ?? "");
		expect(sent).toEqual(["https://93.184.216.34/submit"]);
	},
);

test.each(["oversized", "stalled", "unreadable"])(
	"retains throttling evidence when the body is %s",
	async (kind) => {
		const endpoint = "https://api.poyo.ai/submit";
		const read = filePost(
			endpoint,
			30,
			async () => "93.184.216.34",
			async () =>
				new Response(
					new ReadableStream({
						start(c) {
							if (kind === "oversized") c.enqueue(new Uint8Array(65537));
							if (kind === "unreadable") c.error(new Error("fixture"));
						},
					}),
					{ status: 429, headers: { "Retry-After": "60" } },
				),
		);
		const response = await read(endpoint, { method: "POST" });
		expect(response.status).toBe(429);
		expect(response.headers.get("retry-after")).toBe("60");
		expect(await response.text()).toBe("");
	},
);

test("pinning resolves once before a durable start and hands off synchronously to the reviewed address", async () => {
	const events: string[] = [];
	const url = "https://api.poyo.ai/api/common/upload/stream";
	const read = await pinFilePost(
		url,
		1000,
		async () => {
			events.push("resolve");
			return "93.184.216.34";
		},
		async (target) => {
			events.push(target.hostname);
			return new Response("ok");
		},
	);
	expect(events).toEqual(["resolve"]);
	events.push("durable");
	const pending = read(url, { method: "POST" });
	expect(events).toEqual(["resolve", "durable", "93.184.216.34"]);
	expect(await (await pending).text()).toBe("ok");
	await expect(read(url, { method: "POST" })).rejects.toThrow();
});
