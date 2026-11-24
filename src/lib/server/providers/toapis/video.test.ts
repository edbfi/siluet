import { expect, test } from "bun:test";
import { createToapisVideo } from "./video";

const envelope = {
	id: "task_one",
	model: "seedance-2-5",
	object: "generation.task",
	status: "completed",
	client_business_id: "siluet-abc",
	billing: { status: "pending" },
};
test("lookup requires matching business ID and model, task reads require original task ID", async () => {
	const adapter = (body: unknown) => createToapisVideo(async () => Response.json(body));
	expect(await adapter(envelope).status("fixture", "siluet-abc", null)).toMatchObject({
		kind: "observed",
		taskId: "task_one",
		billing: { status: "pending" },
	});
	for (const edit of [
		{ model: "alias" },
		{ client_business_id: "other" },
		{ object: "task" },
		{ id: "../other" },
	]) {
		expect(
			await adapter({ ...envelope, ...edit }).status("fixture", "siluet-abc", null),
		).toMatchObject({ kind: "paused" });
	}
	expect(await adapter(envelope).status("fixture", "siluet-abc", "other")).toMatchObject({
		kind: "paused",
	});
});

test("uncertain acknowledgements remain distinct from documented policy and access refusals", async () => {
	const draft = {
		model: "seedance-2-5",
		video_operation: "generate",
		duration: 5,
		aspect_ratio: "16:9",
		resolution: "720p",
		generate_audio: true,
		output_format: "mp4",
		return_last_frame: false,
		disable_nsfw: false,
		prompt: "fixture",
	} as const;
	for (const [status, data, expected] of [
		[
			400,
			{ error: { code: "invalid_request", type: "toapis_error" } },
			{ kind: "rejected", reason: "validation" },
		],
		[
			400,
			{ error: { code: "content_policy_violation" } },
			{ kind: "rejected", reason: "filtering" },
		],
		[
			403,
			{ error: { code: "access_denied", type: "toapis_error" } },
			{ kind: "rejected", reason: "authorization" },
		],
		[
			401,
			{ error: { code: "", type: "authentication_error" } },
			{ kind: "rejected", reason: "authorization" },
		],
		[400, { ...envelope, error: { code: "invalid_request" } }, { kind: "unknown" }],
		[
			400,
			{
				error: { code: "invalid_request", message: "Invalid input", param: null },
				request_id: "request-1",
			},
			{ kind: "rejected", reason: "validation" },
		],
		[
			400,
			{ error: { code: "invalid_request", param: { task_id: "task_one" } } },
			{ kind: "unknown" },
		],
		[400, { error: { code: "invalid_request", message: 17 } }, { kind: "unknown" }],
		[
			400,
			{ error: { code: "invalid_request" }, request_id: { id: "task_one" } },
			{ kind: "unknown" },
		],
		[401, { error: { type: "authentication_error", task_id: "task_one" } }, { kind: "unknown" }],
		[400, { error: { code: "invalid_request", task_id: "task_one" } }, { kind: "unknown" }],
		[
			400,
			{ error: { code: "content_policy_violation", task_id: "task_one" } },
			{ kind: "unknown" },
		],
		[403, { error: { code: "access_denied", task_id: "task_one" } }, { kind: "unknown" }],
		[403, { error: { code: "upstream_error" } }, { kind: "unknown" }],
		[429, { error: { code: "invalid_request" } }, { kind: "unknown" }],
		[503, { error: { code: "content_policy_violation" } }, { kind: "unknown" }],
		[200, { ...envelope, client_business_id: "other" }, { kind: "unknown" }],
		[200, envelope, { kind: "accepted", taskId: "task_one" }],
	] as const) {
		let calls = 0;
		const adapter = createToapisVideo(async (url, init) => {
			calls++;
			expect(url).toBe("https://toapis.com/v1/videos/generations");
			expect(init.method).toBe("POST");
			return Response.json(data, { status });
		});
		expect(await adapter.submit("fixture", draft, "siluet-abc")).toEqual(expected);
		expect(calls).toBe(1);
	}
});

test.each([200, 503])(
	"video status and recovery propagate a depleted shared query window (%i)",
	async (status) => {
		const adapter = createToapisVideo(async () =>
			Response.json(envelope, {
				status,
				headers: {
					"X-RateLimit-Category": "async_query",
					"X-RateLimit-Remaining": "0",
					"X-RateLimit-Reset": "1795306300",
				},
			}),
		);
		for (const id of [null, "task_one"]) {
			expect(await adapter.status("fixture", "siluet-abc", id)).toMatchObject({
				queryAfter: 1795306300000,
			});
		}
	},
);

// Keyframe evidence, accessed 2026-11-24:
// https://docs.toapis.com/docs/en/api-reference/videos/seedance-2-5/generation#asset-review
//   submit-time HTTP 400 error.code invalid_private_assets for credentials in a URL, a URL over
//   2,048 bytes or the same URL as different media types; a failed asset review ends the task
//   `failed` with the reason only in error.message and no video generation fee.
// https://docs.toapis.com/docs/en/api-reference/errors
//   invalid_private_assets also covers undecodable images and unreadable URLs; error.reason is
//   optional ("OpenAI video format and Webhooks do not guarantee a reason") and includes
//   reference_media_unreadable for an unreachable URL, invalid file or unsupported format.
// https://docs.toapis.com/docs/en/api-reference/tasks/video-status
//   lists only error.code and error.message on a failed task.
const keyframeBody = {
	model: "seedance-2-5",
	prompt: "fixture",
	video_operation: "generate",
	duration: 5,
	aspect_ratio: "adaptive",
	resolution: "720p",
	generate_audio: true,
	output_format: "mp4",
	return_last_frame: false,
	disable_nsfw: false,
	image_with_roles: [{ url: "https://frames.example.com/a.png?sig=1", role: "first_frame" }],
} as const;
const textBody = {
	model: "seedance-2-5",
	prompt: "fixture",
	video_operation: "generate",
	duration: 5,
	aspect_ratio: "16:9",
	resolution: "720p",
	generate_audio: true,
	output_format: "mp4",
	return_last_frame: false,
	disable_nsfw: false,
} as const;
const privateAssets = {
	success: false,
	error: { code: "invalid_private_assets", type: "invalid_request_error", message: "bad url" },
	request_id: "request-1",
};

test.each([
	["a keyframe body", keyframeBody, privateAssets, { kind: "rejected", reason: "media-input" }],
	["text-to-video", textBody, privateAssets, { kind: "unknown" }],
	[
		"task attributes",
		keyframeBody,
		{ ...privateAssets, id: "task_one", object: "generation.task" },
		{ kind: "unknown" },
	],
	[
		"an unexpected type",
		keyframeBody,
		{ ...privateAssets, error: { ...privateAssets.error, type: "server_error" } },
		{ kind: "unknown" },
	],
	["success true", keyframeBody, { ...privateAssets, success: true }, { kind: "unknown" }],
] as const)("invalid_private_assets on %s", async (_, body, response, expected) => {
	const adapter = createToapisVideo(async () => Response.json(response, { status: 400 }));
	expect(await adapter.submit("fixture", body, "siluet-abc")).toEqual(expected);
});

test.each([
	[
		"reference_media_unreadable",
		{ code: "generation_failed", reason: "reference_media_unreadable", message: "x" },
		"reference_media_unreadable",
	],
	[
		"an unknown reason with a signed URL",
		{
			code: "generation_failed",
			reason: "https://frames.example.com/a.png?sig=secret",
			message: "fetch https://frames.example.com/a.png?sig=secret",
		},
		null,
	],
	[
		"an asynchronous task-type constraint",
		{ code: "InvalidParameter.TaskTypeConstraint", message: "mixed task types" },
		null,
	],
	["no reason", { code: "generation_failed", message: "asset review rejected" }, null],
])("a failed keyframe task with %s", async (_, error, reason) => {
	const adapter = createToapisVideo(async () =>
		Response.json({
			...envelope,
			status: "failed",
			error,
			billing: { status: "refunded", credits: "0", cost_usd: "0" },
		}),
	);
	const observed = await adapter.status("fixture", "siluet-abc", "task_one");
	expect(observed).toMatchObject({
		kind: "observed",
		state: "failed",
		failureReason: reason,
		billing: { status: "refunded", credits: "0", usd: "0" },
	});
	expect(JSON.stringify(observed)).not.toContain("secret");
});

test("a reason on a task that has not failed is never recorded", async () => {
	const adapter = createToapisVideo(async () =>
		Response.json({ ...envelope, status: "queued", error: undefined, reason: "x" }),
	);
	expect(await adapter.status("fixture", "siluet-abc", "task_one")).toMatchObject({
		kind: "observed",
		state: "waiting",
		failureReason: null,
	});
});
