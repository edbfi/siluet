import { afterEach, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { connect, type Socket } from "node:net";
import { closeRequestlessOnStop } from "./stop-connections";

const sockets: Socket[] = [];
afterEach(() => {
	for (const socket of sockets.splice(0)) socket.destroy();
});

/** A connection that has not sent a whole request; Bun 1.4.5's graceful stop waits for it. */
async function idleConnection(port: number) {
	const socket = connect(port, "127.0.0.1");
	sockets.push(socket);
	socket.on("error", () => {});
	await new Promise((resolve) => socket.once("connect", resolve));
	socket.write("GET /");
	return socket;
}

test("a stop with no request in flight closes connections that never sent one", async () => {
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("ok") });
	const lifecycle = new EventEmitter();
	closeRequestlessOnStop(lifecycle)(server);
	const socket = await idleConnection(Number(server.port));
	// A full round trip on another connection lets the server accept the idle one first.
	expect(await (await fetch(server.url)).text()).toBe("ok");
	const closed = new Promise((resolve) => socket.once("close", resolve));
	lifecycle.emit("siluet:stopping");
	const stopped = server.stop().then(() => "stopped");
	// Without the close, the stop waits until the client gives up.
	const client = Bun.sleep(4000).then(() => "client still open");
	expect(await Promise.race([stopped, client])).toBe("stopped");
	await closed;
});

test("a response still in flight finishes before the idle connections close", async () => {
	const release = Promise.withResolvers<void>();
	const started = Promise.withResolvers<void>();
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: (request) =>
			new URL(request.url).pathname === "/ok"
				? new Response("ok")
				: new Response(
						new ReadableStream({
							async start(controller) {
								controller.enqueue(new TextEncoder().encode("a"));
								started.resolve();
								await release.promise;
								controller.enqueue(new TextEncoder().encode("b"));
								controller.close();
							},
						}),
					),
	});
	const lifecycle = new EventEmitter();
	closeRequestlessOnStop(lifecycle)(server);
	const response = fetch(server.url).then((r) => r.text());
	await started.promise;
	const socket = await idleConnection(Number(server.port));
	expect(await (await fetch(new URL("/ok", server.url))).text()).toBe("ok");
	const closed = new Promise((resolve) => socket.once("close", resolve));
	lifecycle.emit("siluet:stopping");
	const stopped = server.stop();
	// The stop drains the response before it touches the idle connection.
	await Bun.sleep(50);
	expect(socket.destroyed).toBe(false);
	release.resolve();
	expect(await response).toBe("ab");
	await stopped;
	await closed;
});
