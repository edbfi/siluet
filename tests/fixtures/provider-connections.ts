export const providerFixtureKeys = {
	poyo: "fixture-poyo-main-secret",
	rejected: "fixture-poyo-rejected-secret",
	unavailable: "fixture-poyo-unavailable-secret",
	slow: "fixture-poyo-delayed-secret",
	toapis: "fixture-toapis-seedream-secret",
	restricted: "fixture-toapis-restricted-secret",
} as const;

export const providerFixtureAccount = "fixture-poyo-account@example.test";

export function startProviderFixtures(
	jobResponse?: (request: Request, path: string) => Response | null,
) {
	const requests: { path: string; method: string; key: string | null }[] = [];
	const slowStarted = Promise.withResolvers<void>();
	const slowRelease = Promise.withResolvers<void>();
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const { pathname: path } = new URL(request.url);
			const authorization = request.headers.get("authorization");
			const key = authorization?.startsWith("Bearer ") ? authorization.slice(7) : null;
			requests.push({ path, method: request.method, key });
			const job = jobResponse?.(request, path);
			if (job) return job;
			if (request.method !== "GET") return new Response(null, { status: 405 });
			if (path === "/poyo/balance") {
				if (key === providerFixtureKeys.slow) {
					slowStarted.resolve();
					await slowRelease.promise;
				}
				if (key === providerFixtureKeys.poyo || key === providerFixtureKeys.slow)
					return Response.json({
						code: 200,
						data: { email: providerFixtureAccount, credits_amount: 0 },
					});
				if (key === providerFixtureKeys.unavailable)
					return new Response(`Fixture outage mentioning ${key}`, { status: 503 });
			}
			if (path === "/toapis/models") {
				if (key === providerFixtureKeys.toapis || key === providerFixtureKeys.restricted)
					return Response.json({
						success: true,
						object: "list",
						data: key === providerFixtureKeys.toapis ? [{ id: "doubao-seedream-5-5" }] : [],
					});
			}
			return Response.json({ message: `Fixture rejected ${key}` }, { status: 401 });
		},
	});

	return {
		requests,
		env: {
			BUN_OPTIONS: "--preload ./tests/fixtures/provider-fetch.ts",
			SILUET_TEST_PROVIDER_ORIGIN: server.url.origin,
		},
		slowStarted: slowStarted.promise,
		releaseSlow: () => slowRelease.resolve(),
		stop: () => {
			slowRelease.resolve();
			return server.stop(true);
		},
	};
}
