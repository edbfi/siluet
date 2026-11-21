import type { ServerInit } from "@sveltejs/kit/hooks";

// The adapter reads its listener overrides after initializing the application.
export const init: ServerInit = () => {
	const host = process.env.SILUET_SERVER_HOST;
	if (
		(host !== undefined && host !== "127.0.0.1" && host !== "::1") ||
		process.env.SILUET_SERVER_SOCKET_PATH
	) {
		throw new Error("Siluet requires a loopback TCP listener (127.0.0.1 or ::1).");
	}
};
