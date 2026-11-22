import { expect, jest, test } from "bun:test";
import { downloadImage } from "./download";

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
		new Response("large", { headers: { "content-length": String(32 * 1024 * 1024 + 1) } }),
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
