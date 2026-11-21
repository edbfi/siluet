export function studioOrigin(env: Record<string, string | undefined>, dev = false) {
	const host = env.SILUET_SERVER_HOST ?? "127.0.0.1";
	if ((host !== "127.0.0.1" && host !== "::1") || env.SILUET_SERVER_SOCKET_PATH)
		throw new Error("Siluet requires a loopback TCP listener (127.0.0.1 or ::1).");
	if (
		["HOST_HEADER", "PORT_HEADER", "PROTOCOL_HEADER", "ADDRESS_HEADER", "XFF_DEPTH"].some(
			(key) => env[`SILUET_SERVER_${key}`] !== undefined,
		)
	)
		throw new Error("Forwarded listener settings are unsupported.");
	const port = dev ? "5173" : env.SILUET_SERVER_PORT;
	if (!port || !/^[1-9]\d{0,4}$/.test(port) || Number(port) > 65535)
		throw new Error("A concrete loopback port is required.");
	const origin = new URL(`http://${host === "::1" ? "[::1]" : host}:${port}`);
	if (
		(!dev || env.SILUET_SERVER_ORIGIN !== undefined) &&
		env.SILUET_SERVER_ORIGIN !== origin.origin
	)
		throw new Error("Start Siluet with its configured loopback origin.");
	return origin;
}
