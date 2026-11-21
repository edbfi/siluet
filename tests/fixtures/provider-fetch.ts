// Bun preloads this module only in the fixture launcher and its built server.
const fixtureOrigin = process.env.SILUET_TEST_PROVIDER_ORIGIN;
const endpoints = new Map([
	["https://api.poyo.ai/api/user/balance", "/poyo/balance"],
	["https://toapis.com/v1/models?type=image", "/toapis/models"],
]);

if (!fixtureOrigin) throw new Error("Missing provider fixture origin.");

globalThis.fetch = new Proxy(globalThis.fetch, {
	async apply(read: typeof fetch, _receiver, [input, init]: Parameters<typeof fetch>) {
		const url = new URL(input instanceof Request ? input.url : input);
		const path = endpoints.get(url.href);
		if (path) return read(new URL(path, fixtureOrigin), init);
		// Track every other server-side request without contacting its destination.
		await read(new URL("/unexpected", fixtureOrigin), { method: "POST" });
		throw new Error("Unexpected outbound request in provider fixture.");
	},
});
