import type { EventEmitter } from "node:events";
import type { Server } from "bun";

const drainPollMs = 20;

/**
 * Bun 1.4.5's graceful `stop()` also waits for a connection that has not sent a whole
 * request, until the client closes it or Bun's idle timeout. Firefox keeps a spare
 * connection open for several seconds, so a stop with Firefox open waited that long.
 * Once a stop has no request in flight, close the connections that remain.
 *
 * Returns the hook's way to name the server, which only a request can reach. Known limits: a
 * stop before any request reaches the hook (only static assets or bare preconnects) keeps
 * Bun's wait; a request whose headers are still arriving when the last one ends is reset, not
 * served, which on loopback is a sub-millisecond window during shutdown.
 */
export function closeRequestlessOnStop(lifecycle: EventEmitter) {
	let server: Server<undefined> | undefined;
	let stopped = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const later = () => {
		timer = setTimeout(drain, drainPollMs);
		timer.unref();
	};
	const drain = () => {
		if (!server || stopped) return;
		if (server.pendingRequests > 0) later();
		else void server.stop(true);
	};
	// The adapter starts its graceful stop on the same signal; check once it has.
	lifecycle.once("siluet:stopping", () => setTimeout(drain, 0));
	// Once the adapter has stopped, nothing is left to drain.
	lifecycle.once("sveltekit:shutdown", () => {
		stopped = true;
		clearTimeout(timer);
	});
	return (current: Server<undefined> | undefined) => {
		server ??= current;
	};
}
