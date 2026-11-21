import { afterEach, beforeEach, expect, test } from "bun:test";
import { studioOrigin } from "./lib/server/services/owner/origin";

const init = () => studioOrigin(process.env, true);

const listenerKeys = ["SILUET_SERVER_HOST", "SILUET_SERVER_SOCKET_PATH"] as const;
const original = new Map(listenerKeys.map((key) => [key, process.env[key]]));

beforeEach(() => {
	for (const key of listenerKeys) delete process.env[key];
});

afterEach(() => {
	for (const [key, value] of original) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

test("accepts the default loopback listener", async () => {
	await init();
});

test.each(["127.0.0.1", "::1"])("accepts loopback host %s", async (host) => {
	process.env.SILUET_SERVER_HOST = host;
	await init();
});

test.each(["", "0.0.0.0", "::"])("rejects wildcard host %j", (host) => {
	process.env.SILUET_SERVER_HOST = host;
	expect(init).toThrow("loopback TCP listener");
});

test("rejects a socket path even with a loopback host", () => {
	process.env.SILUET_SERVER_HOST = "127.0.0.1";
	process.env.SILUET_SERVER_SOCKET_PATH = "siluet.sock";
	expect(init).toThrow("loopback TCP listener");
});

test("built entry requires an exact numeric listener and disallows proxy settings", () => {
	const env = { SILUET_SERVER_PORT: "3000", SILUET_SERVER_ORIGIN: "http://127.0.0.1:3000" };
	expect(studioOrigin(env).origin).toBe(env.SILUET_SERVER_ORIGIN);
	for (const override of [
		{ SILUET_SERVER_PORT: "0" },
		{ SILUET_SERVER_ORIGIN: undefined },
		{ SILUET_SERVER_HOST_HEADER: "host" },
		{ SILUET_SERVER_ORIGIN: "http://127.0.0.1:3001" },
	])
		expect(() => studioOrigin({ ...env, ...override })).toThrow();
});
