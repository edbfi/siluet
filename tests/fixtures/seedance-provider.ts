import { expect } from "@playwright/test";

/** ToAPIs Seedance fixtures: one accepted task that completes with `bytes` at a public media URL. */
export function seedanceProvider(bytes: Buffer, submit: (request: Request) => Promise<string>) {
	return async (request: Request, path: string) => {
		if (path === "/toapis/video-models")
			return Response.json({ success: true, object: "list", data: [{ id: "seedance-2-5" }] });
		if (path === "/toapis/video-submit")
			return Response.json({
				object: "generation.task",
				id: "clip_1",
				model: "seedance-2-5",
				client_business_id: await submit(request),
				status: "queued",
			});
		if (path === "/toapis/video-status/clip_1")
			return Response.json({
				object: "generation.task",
				id: "clip_1",
				model: "seedance-2-5",
				status: "completed",
				progress: 100,
				billing: { status: "settled", credits: "7", cost_usd: "0.035" },
				result: {
					type: "video",
					data: [{ url: "https://93.184.216.34/result/video?key=secret-result" }],
				},
			});
		if (path === "/media/video") {
			expect(request.headers.has("authorization")).toBe(false);
			expect(request.headers.has("cookie")).toBe(false);
			return new Response(new Uint8Array(bytes));
		}
		return null;
	};
}
