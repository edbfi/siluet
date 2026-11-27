import type { EventEmitter } from "node:events";
import type { Server } from "bun";

const drainPollMs = 20;

/**
 * Bun 1.4.5's graceful `stop()` also waits for a connection that has not sent a whole
 * request, until the client closes it or Bun's idle timeout. Firefox keeps a spare
 * connection open for several seconds, so a stop with Firefox open waited that long.
 * Once a stop has no request in flight, close the connections that remain.
 * Returns the hook's way to name the server, which only a request can reach.
 */
export function closeRequestlessOnStop(lifecycle: EventEmitter) {
	let server: Server<undefined> | undefined;
	const drain = () => {
		if (!server) return;
		if (server.pendingRequests > 0) setTimeout(drain, drainPollMs);
		else void server.stop(true);
	};
	// The adapter starts its graceful stop on the same signal; check once it has.
	lifecycle.once("siluet:stopping", () => setTimeout(drain, 0));
	return (current: Server<undefined> | undefined) => {
		server ??= current;
	};
}
