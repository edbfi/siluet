import { expect, test } from "bun:test";
import { checkToapisConnection } from "./connection";

const key = "fixture-toapis-model-key";

// https://docs.toapis.com/docs/en/api-reference/chat/list-models
// type=image filters the current key and user group's catalog. Match the exact model id from
// https://docs.toapis.com/docs/en/api-reference/images/seedream-5.5/generation.
test("ToAPIs reads the key's image catalog once and reports access to Seedream 5.5", async () => {
	let reads = 0;
	const check = checkToapisConnection(async (url, init) => {
		reads++;
		expect(url).toBe("https://toapis.com/v1/models?type=image");
		expect(init).toMatchObject({
			method: "GET",
			redirect: "error",
			headers: { Authorization: `Bearer ${key}` },
		});
		return Response.json({
			success: true,
			object: "list",
			data: [{ id: "doubao-seedream-5-5", object: "model", owned_by: "fixture-account" }],
		});
	});
	expect(await check(key)).toEqual({ outcome: "accepted", seedream: true });
	expect(reads).toBe(1);
});

test.each([[], [{ id: "doubao-seedream-5-0" }]])(
	"ToAPIs accepts valid keys whose image catalog omits Seedream 5.5",
	async (...models) => {
		const check = checkToapisConnection(async () =>
			Response.json({ success: true, object: "list", data: models }),
		);
		expect(await check(key)).toEqual({ outcome: "accepted", seedream: false });
	},
);

// https://docs.toapis.com/docs/en/api-reference/errors
test.each([401, 403])("ToAPIs maps HTTP %d to a rejected check", async (status) => {
	const check = checkToapisConnection(async () => new Response(key, { status }));
	expect(await check(key)).toEqual({ outcome: "rejected" });
});

test.each([
	() => new Response(key, { status: 429 }),
	() => new Response(key, { status: 500 }),
	() => Response.json({ success: false, object: "list", data: [] }),
	() => Response.json({ success: true, object: "list", data: [{}] }),
	() => Response.json({ success: true, object: "list", data: [], padding: key.repeat(150_000) }),
])("ToAPIs leaves an inconclusive or oversized response unavailable", async (reply) => {
	const check = checkToapisConnection(async () => reply());
	expect(await check(key)).toEqual({ outcome: "unavailable" });
});
