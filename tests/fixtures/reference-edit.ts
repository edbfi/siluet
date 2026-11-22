import type { SeedreamProvider } from "../../src/lib/shared/image-studio/seedream";
import { startProviderFixtures } from "./provider-connections";

export const referenceHost = "93.184.216.34";
export const referencePathMarker = "private-edit-path";
export const referenceQueryMarker = "private-edit-query";
export const referenceFragmentMarker = "private-edit-fragment";
export const signedReference = `HTTPS://${referenceHost}:443/${referencePathMarker}%2fscene%20A.png?sig=${referenceQueryMarker}%2B%2f&part=one&part=two#${referenceFragmentMarker}`;
export const editedImagePath = "/media/reference-edit.png";
export const editedImageSignature = "fixture-edited-result-signature";
export const editedPng = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAD0lEQVQImWNYFVq+KrQcAAqnAu1VEKqPAAAAAElFTkSuQmCC",
	"base64",
);

type Outcome = "completed" | "download-fails-once" | "rejected" | "failed" | "timeout";

export function referenceEditFixtures(provider: SeedreamProvider, outcome: Outcome = "completed") {
	const submissions: unknown[] = [];
	const taskId = `${provider}-reference-edit-fixture`;
	const result = `https://${referenceHost}/result/reference-edit.png?sig=${editedImageSignature}`;
	let downloads = 0;
	// Provider response fields follow the Seedream submit, status and error contracts.
	const fixture = startProviderFixtures(async (request, path) => {
		if (path === `/${provider}/submit` && request.method === "POST") {
			submissions.push((await request.json()) as unknown);
			if (outcome === "timeout") {
				return new Response(signedReference, { headers: { "x-siluet-fixture-timeout": "yes" } });
			}
			if (outcome === "rejected") {
				return provider === "poyo"
					? Response.json({
							code: 400,
							error: { type: "file_format_error", message: signedReference },
						})
					: Response.json(
							{ error: { code: "invalid_image", message: signedReference } },
							{ status: 400 },
						);
			}
			return provider === "poyo"
				? Response.json({ code: 200, data: { task_id: taskId } })
				: Response.json({ id: taskId, status: "pending" });
		}
		if (path === `/${provider}/status/${taskId}`) {
			if (outcome === "failed") {
				return Response.json({
					id: taskId,
					status: "failed",
					error: {
						code: "generation_failed",
						reason: "reference_media_unreadable",
						input_media_errors: [{ message: signedReference }],
					},
				});
			}
			return provider === "poyo"
				? Response.json({
						code: 200,
						data: {
							task_id: taskId,
							status: "finished",
							credits_amount: 8.6,
							files: [{ file_type: "image", file_url: result }],
						},
					})
				: Response.json({
						id: taskId,
						status: "completed",
						billing: { status: "settled", credits: "5.6", cost_usd: "0.028" },
						result: { type: "image", data: [{ url: result }] },
					});
		}
		if (path === editedImagePath) {
			downloads++;
			const signature = new URL(request.url).searchParams.get("sig");
			if (
				signature !== editedImageSignature ||
				request.headers.has("authorization") ||
				request.headers.has("cookie")
			)
				return new Response(null, { status: 403 });
			if (downloads === 1 && outcome === "download-fails-once")
				return new Response(signedReference, { status: 502 });
			return new Response(editedPng, { headers: { "content-type": "image/png" } });
		}
		return null;
	});
	return { ...fixture, submissions, statusPath: `/${provider}/status/${taskId}` };
}
