import type { SeedreamProvider } from "../../src/lib/shared/image-studio/seedream-options";
import { startProviderFixtures } from "./provider-connections";

export const referenceHost = "93.184.216.34";
export const referencePathMarker = "private-edit-path";
export const referenceQueryMarker = "private-edit-query";
export const referenceFragmentMarker = "private-edit-fragment";
export const signedReference = `HTTPS://${referenceHost}:443/${referencePathMarker}%2fscene%20A.png?sig=${referenceQueryMarker}%2B%2f&part=one&part=two#${referenceFragmentMarker}`;
const secondReferenceMarkers = [
	"private-second-path",
	"private-second-query",
	"private-second-fragment",
] as const;
export const secondSignedReference = `https://${referenceHost}/${secondReferenceMarkers[0]}%2Fb.png?part=two&sig=${secondReferenceMarkers[1]}%2b&part=one#${secondReferenceMarkers[2]}`;
const extraReferenceMarker = "private-extra-reference";
export const tenSignedReferences = [
	secondSignedReference,
	signedReference,
	...Array.from(
		{ length: 8 },
		(_, index) => `https://${referenceHost}/${extraReferenceMarker}-${index + 3}.png`,
	),
];
const providerEchoMarker = "private-provider-error-detail";
export const referenceMarkers = [
	referenceHost,
	referencePathMarker,
	referenceQueryMarker,
	referenceFragmentMarker,
	...secondReferenceMarkers,
	extraReferenceMarker,
	providerEchoMarker,
];
export const editedImagePath = "/media/reference-edit.png";
export const editedImageSignature = "fixture-edited-result-signature";
export const editedPng = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAD0lEQVQImWNYFVq+KrQcAAqnAu1VEKqPAAAAAElFTkSuQmCC",
	"base64",
);

type Outcome =
	| "crash-after-acceptance"
	| "mixed-batch"
	| "completed"
	| "link-missing-once"
	| "rejected"
	| "failed"
	| "timeout";

export function referenceEditFixtures(
	provider: SeedreamProvider,
	outcome: Outcome = "completed",
	prompt = "",
) {
	const submissions: unknown[] = [];
	const statusPaths: string[] = [];
	const uploads: { file: File; parts: string[] }[] = [];
	const hosted = "https://different.storage.net/reference?sig=fixture-upload-link";
	// Each upload's own hosted link: the first is `hosted`, later ones add their number.
	const hostedFor = (upload: number) => (upload === 1 ? hosted : `${hosted}-${upload}`);
	const result = `https://${referenceHost}/result/reference-edit.png?sig=${editedImageSignature}`;
	let completions = 0;
	// Provider response fields follow the Seedream submit, status and error contracts.
	const fixture = startProviderFixtures(async (request, path) => {
		// Upload responses follow the Poyo.ai stream and ToAPIs image upload contracts.
		if (path === `/${provider}/upload` && request.method === "POST") {
			const parts = await request.formData();
			const file = parts.get("file");
			if (!(file instanceof File)) return new Response(null, { status: 400 });
			uploads.push({ file, parts: [...parts.keys()] });
			const url = hostedFor(uploads.length);
			return Response.json(
				provider === "poyo"
					? {
							success: true,
							code: 200,
							data: {
								file_id: "fixture-id",
								file_url: url,
								mime_type: file.type,
								file_size: file.size,
							},
						}
					: {
							success: true,
							data: { id: "fixture-id", url, mime_type: file.type, size: file.size },
						},
			);
		}
		if (path === `/${provider}/submit` && request.method === "POST") {
			submissions.push((await request.json()) as unknown);
			const echo = `${providerEchoMarker} ${prompt} ${signedReference} ${secondSignedReference}`;
			if (outcome === "timeout") {
				return new Response(echo, { headers: { "x-siluet-fixture-timeout": "yes" } });
			}
			if (outcome === "rejected") {
				return provider === "poyo"
					? Response.json({
							code: 400,
							error: { type: "file_format_error", message: echo },
						})
					: Response.json({ error: { code: "invalid_image", message: echo } }, { status: 400 });
			}
			if (outcome === "crash-after-acceptance" && submissions.length === 2)
				return Response.json(
					{ id: "never-recorded" },
					{ headers: { "x-siluet-fixture-exit": "yes" } },
				);
			const taskId = `${provider}-reference-edit-fixture-${submissions.length}`;
			statusPaths.push(`/${provider}/status/${taskId}`);
			return provider === "poyo"
				? Response.json({ code: 200, data: { task_id: taskId, metadata: echo } })
				: Response.json({ id: taskId, status: "pending", metadata: echo });
		}
		if (statusPaths.includes(path)) {
			const taskId = path.split("/").at(-1);
			if (outcome === "failed" || (outcome === "mixed-batch" && path === statusPaths[0])) {
				const message = `${providerEchoMarker} ${secondSignedReference}`;
				if (provider === "poyo") {
					return Response.json({
						code: 200,
						data: { task_id: taskId, status: "failed", error: { message } },
					});
				}
				return Response.json({
					id: taskId,
					status: "failed",
					error: {
						code: "generation_failed",
						reason: "reference_media_unreadable",
						message: `${providerEchoMarker} ${prompt}`,
						input_media_errors: [{ index: 0, message }],
					},
				});
			}
			// The first completion of a link-missing fixture carries no usable result link.
			const files = ++completions === 1 && outcome === "link-missing-once" ? [] : [{ url: result }];
			return provider === "poyo"
				? Response.json({
						code: 200,
						data: {
							task_id: taskId,
							status: "finished",
							credits_amount: 8.6,
							files: files.map(({ url }) => ({ file_type: "image", file_url: url })),
						},
					})
				: Response.json({
						id: taskId,
						status: "completed",
						billing: { status: "settled", credits: "5.6", cost_usd: "0.028" },
						result: { type: "image", data: files },
					});
		}
		if (path === editedImagePath) {
			const signature = new URL(request.url).searchParams.get("sig");
			if (
				signature !== editedImageSignature ||
				request.headers.has("authorization") ||
				request.headers.has("cookie")
			)
				return new Response(null, { status: 403 });
			return new Response(editedPng, { headers: { "content-type": "image/png" } });
		}
		return null;
	});
	return { ...fixture, uploads, hosted, hostedFor, submissions, statusPaths };
}
