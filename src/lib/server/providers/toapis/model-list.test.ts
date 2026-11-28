import { afterEach, expect, test } from "bun:test";
import { createServer, type Server } from "node:net";
import { readModelList } from "./model-list";

const key = "fixture-toapis-inventory-key";
const listed = {
	success: true,
	object: "list",
	data: [
		{
			id: "seedance-2-5",
			object: "model",
			created: 1,
			owned_by: "fixture",
			supported_endpoint_types: [],
		},
		{ id: "doubao-seedream-5-5", object: "model", created: 1, owned_by: "fixture" },
		{ id: "fixture-derived-image", object: "model", created: 1, owned_by: "fixture" },
	],
};

const servers: { stop: () => unknown }[] = [];
afterEach(async () => {
	await Promise.all(servers.splice(0).map((server) => server.stop()));
});

test.each([
	["image", "https://toapis.com/v1/models?type=image"],
	["video", "https://toapis.com/v1/models?type=video"],
] as const)(
	"the %s list is one body-less GET that returns the sorted exact IDs",
	async (scope, url) => {
		const calls: { url: string; init: RequestInit }[] = [];
		const read = readModelList(async (url, init) => {
			calls.push({ url, init });
			return Response.json(listed);
		});
		expect(await read(key, scope)).toEqual({
			outcome: "succeeded",
			models: ["doubao-seedream-5-5", "fixture-derived-image", "seedance-2-5"],
		});
		expect(calls).toHaveLength(1);
		expect(calls[0].url).toBe(url);
		expect(calls[0].init).toMatchObject({
			method: "GET",
			redirect: "error",
			headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
		});
		expect(calls[0].init.body).toBeUndefined();
	},
);

test("an empty list is a success that lists nothing, and duplicates collapse to one", async () => {
	const empty = readModelList(async () => Response.json({ ...listed, data: [] }));
	expect(await empty(key, "image")).toEqual({ outcome: "succeeded", models: [] });
	const repeated = readModelList(async () =>
		Response.json({ ...listed, data: [...listed.data, listed.data[1]] }),
	);
	expect(await repeated(key, "image")).toEqual({
		outcome: "succeeded",
		models: ["doubao-seedream-5-5", "fixture-derived-image", "seedance-2-5"],
	});
});

test("a configured origin is read instead of the default", async () => {
	let seen = "";
	const read = readModelList(
		async (url) => {
			seen = url;
			return Response.json(listed);
		},
		{ origin: "https://fixture.example" },
	);
	await read(key, "video");
	expect(seen).toBe("https://fixture.example/v1/models?type=video");
});

test.each([401, 403])("HTTP %d is a refused key", async (status) => {
	const read = readModelList(async () => new Response(key, { status }));
	expect(await read(key, "image")).toEqual({ outcome: "rejected" });
});

test.each([
	["a 500 with an HTML body", () => new Response("<html>fixture outage</html>", { status: 500 })],
	["a 429", () => new Response(key, { status: 429 })],
	["success:false", () => Response.json({ ...listed, success: false })],
	["a missing object", () => Response.json({ success: true, data: listed.data })],
	["a non-string id", () => Response.json({ ...listed, data: [{ id: 7 }] })],
	["an empty id", () => Response.json({ ...listed, data: [{ id: "" }] })],
	["no data array", () => Response.json({ success: true, object: "list" })],
	["malformed JSON", () => new Response("{", { headers: { "content-type": "application/json" } })],
	["a body over 2 MiB", () => Response.json({ ...listed, padding: "x".repeat(2 * 1024 * 1024) })],
])("%s is unavailable", async (_, reply) => {
	const read = readModelList(async () => reply());
	expect(await read(key, "image")).toEqual({ outcome: "unavailable" });
});

test("a timeout is unavailable, never unreachable", async () => {
	const read = readModelList(
		(_, init) =>
			new Promise((_, reject) =>
				init.signal?.addEventListener("abort", () => reject(init.signal?.reason)),
			),
		{ timeoutMs: 10 },
	);
	expect(await read(key, "image")).toEqual({ outcome: "unavailable" });
});

// Bun's fetch names a failure before any response by its code. Only connect-stage codes are
// unreachable; a redirect, a reset, a TLS failure or any other rejection is a failed check.
test("a refused connection is unreachable", async () => {
	const closed = createServer();
	await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
	const { port } = closed.address() as { port: number };
	await new Promise((resolve) => closed.close(resolve));
	const read = readModelList(fetch, { origin: `http://127.0.0.1:${port}` });
	expect(await read(key, "image")).toEqual({ outcome: "unreachable" });
});

test.each(["ENOTFOUND", "EAI_AGAIN", "ESERVFAIL", "ECONNREFUSED", "ENETUNREACH", "EHOSTUNREACH"])(
	"%s is unreachable",
	async (code) => {
		const read = readModelList(async () => {
			throw Object.assign(new TypeError("fixture connect failure"), { code });
		});
		expect(await read(key, "video")).toEqual({ outcome: "unreachable" });
	},
);

test.each(["ECONNRESET", "EPROTO", "CERT_HAS_EXPIRED", "UnexpectedRedirect", undefined])(
	"a rejection coded %s is unavailable",
	async (code) => {
		const read = readModelList(async () => {
			throw Object.assign(new TypeError("fixture failure"), { code });
		});
		expect(await read(key, "video")).toEqual({ outcome: "unavailable" });
	},
);

test("a redirect is unavailable", async () => {
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: () => new Response(null, { status: 302, headers: { location: "/elsewhere" } }),
	});
	servers.push({ stop: () => server.stop(true) });
	const read = readModelList(fetch, { origin: server.url.origin });
	expect(await read(key, "image")).toEqual({ outcome: "unavailable" });
});

test("a connection reset after the request starts is unavailable", async () => {
	const reset: Server = createServer((socket) => socket.on("data", () => socket.resetAndDestroy()));
	await new Promise<void>((resolve) => reset.listen(0, "127.0.0.1", resolve));
	servers.push({ stop: () => new Promise((resolve) => reset.close(resolve)) });
	const { port } = reset.address() as { port: number };
	const read = readModelList(fetch, { origin: `http://127.0.0.1:${port}` });
	expect(await read(key, "image")).toEqual({ outcome: "unavailable" });
});
