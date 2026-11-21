import { referencePng } from "./reference-image";

// Responses authored from the provider contracts. Set the stop point only inside a built-app test.
export function jobResponses(crash?: "before-dispatch" | "after-acceptance") {
	let balances = 0;
	const result = "https://93.184.216.34/result/image?expires=fixture-private-signed-token";
	return (request: Request, path: string) => {
		const stop = () => new Response(null, { headers: { "x-siluet-fixture-exit": "yes" } });
		if (path === "/poyo/balance" && ++balances === 2 && crash === "before-dispatch") return stop();
		if (path === "/poyo/submit" && request.method === "POST")
			return crash === "after-acceptance"
				? stop()
				: Response.json({ code: 200, data: { task_id: "poyo-fixture-1" } });
		if (path === "/toapis/submit" && request.method === "POST")
			return Response.json({ id: "toapis-fixture-1", status: "pending" });
		if (path === "/poyo/status/poyo-fixture-1")
			return Response.json({
				code: 200,
				data: {
					task_id: "poyo-fixture-1",
					status: "finished",
					credits_amount: 7,
					files: [{ file_type: "image", file_url: result }],
				},
			});
		if (path === "/toapis/status/toapis-fixture-1")
			return Response.json({
				id: "toapis-fixture-1",
				status: "completed",
				billing: { status: "settled", credits: "5.6", cost_usd: "0.028" },
				result: { type: "image", data: [{ url: result }] },
			});
		if (path === "/media/image")
			return request.headers.has("authorization") || request.headers.has("cookie")
				? new Response(null, { status: 403 })
				: new Response(referencePng, { headers: { "content-type": "image/png" } });
		return null;
	};
}
