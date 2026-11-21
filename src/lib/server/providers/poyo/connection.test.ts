import { expect, test } from "bun:test";
import { checkPoyoConnection } from "./connection";

const key = "fixture-poyo-model-key";

// Query User Balance: https://docs.poyo.ai/api-manual/account-management/user-balance
// The balance accepts the model key, including accounts with zero credits. It
// does not report per-key model access. Seedream support is documented at
// https://docs.poyo.ai/api-manual/image-series/seedream-5-5.
test("Poyo verifies the key with one authenticated balance read and discards account fields", async () => {
	let reads = 0;
	const check = checkPoyoConnection(async (url, init) => {
		reads++;
		expect(url).toBe("https://api.poyo.ai/api/user/balance");
		expect(init).toMatchObject({
			method: "GET",
			redirect: "error",
			headers: { Authorization: `Bearer ${key}` },
		});
		return Response.json({
			code: 200,
			data: { email: "fixture-account@example.test", credits_amount: 0 },
		});
	});
	expect(await check(key)).toEqual({ outcome: "accepted", seedream: true });
	expect(reads).toBe(1);
});

// HTTP and business authentication/permission errors:
// https://docs.poyo.ai/api-manual/error-codes
test.each([401, 403])("Poyo maps HTTP %d to a rejected check", async (status) => {
	const check = checkPoyoConnection(async () => new Response(key, { status }));
	expect(await check(key)).toEqual({ outcome: "rejected" });
});

test("Poyo also recognizes an authentication refusal in a success HTTP response", async () => {
	const check = checkPoyoConnection(async () =>
		Response.json({ code: 401, error: { message: key } }),
	);
	expect(await check(key)).toEqual({ outcome: "rejected" });
});

test.each([
	() => new Response("503 unavailable", { status: 503 }),
	() => new Response("429 rate limit", { status: 429 }),
	() => Response.json({ code: 200, data: {} }),
	() => Response.json({ code: 429, error: { message: key } }),
	() => new Response("invalid JSON"),
	() => {
		throw new Error(key);
	},
])("Poyo treats an inconclusive response or network error as unavailable", async (reply) => {
	const check = checkPoyoConnection(async () => reply());
	expect(await check(key)).toEqual({ outcome: "unavailable" });
});

test("Bun refuses redirected balance reads before reaching the redirect destination", async () => {
	let balanceReads = 0;
	let redirectedReads = 0;
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request) {
			if (new URL(request.url).pathname === "/balance") {
				balanceReads++;
				return Response.redirect(new URL("/redirect", request.url), 307);
			}
			redirectedReads++;
			return Response.json({ code: 200, data: { credits_amount: 10 } });
		},
	});
	try {
		const check = checkPoyoConnection((_url, init) => fetch(new URL("/balance", server.url), init));
		expect(await check(key)).toEqual({ outcome: "unavailable" });
		expect(balanceReads).toBe(1);
		expect(redirectedReads).toBe(0);
	} finally {
		await server.stop(true);
	}
});
