// Bun preloads this module only in the fixture launcher and its built server.
const fixtureOrigin = process.env.SILUET_TEST_PROVIDER_ORIGIN;
const endpoints = new Map([
	["https://api.poyo.ai/api/user/balance", "/poyo/balance"],
	["https://toapis.com/v1/models?type=image", "/toapis/models"],
]);

if (!fixtureOrigin) throw new Error("Missing provider fixture origin.");

const fixtureTime = process.env.SILUET_TEST_PROVIDER_TIME;
if (fixtureTime !== undefined) {
	const systemTime = Date.now.bind(Date);
	const offset = Number(fixtureTime) - systemTime();
	Date.now = () => systemTime() + offset;
}

globalThis.fetch = new Proxy(globalThis.fetch, {
	async apply(read: typeof fetch, _receiver, [input, init]: Parameters<typeof fetch>) {
		const url = new URL(input instanceof Request ? input.url : input);
		let path = endpoints.get(url.href);
		if (url.origin === "https://api.poyo.ai") {
			if (url.pathname === "/api/generate/submit") path = "/poyo/submit";
			if (url.pathname.startsWith("/api/generate/status/"))
				path = url.pathname.replace("/api/generate/status/", "/poyo/status/");
		}
		if (url.origin === "https://toapis.com") {
			if (url.pathname === "/v1/images/generations") path = "/toapis/submit";
			if (url.pathname.startsWith("/v1/images/generations/"))
				path = url.pathname.replace("/v1/images/generations/", "/toapis/status/");
		}
		if (url.origin === "https://93.184.216.34" && url.pathname === "/result/image")
			path = "/media/image";
		if (url.origin === "https://93.184.216.34" && url.pathname === "/result/reference-edit.png")
			path = `/media/reference-edit.png${url.search}`;
		if (path) {
			const response = await read(new URL(path, fixtureOrigin), init);
			if (response.headers.get("x-siluet-fixture-exit") === "yes") process.exit(79);
			if (response.headers.has("x-siluet-fixture-timeout"))
				throw new DOMException(await response.text(), "TimeoutError");
			return response;
		}
		// Track every other server-side request without contacting its destination.
		await read(new URL("/unexpected", fixtureOrigin), { method: "POST" });
		throw new Error("Unexpected outbound request in provider fixture.");
	},
});
