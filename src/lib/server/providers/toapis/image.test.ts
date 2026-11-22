import { expect, test } from "bun:test";
import { createToapisImage } from "./image";

const request = {
	method: "POST",
	url: "https://toapis.com/v1/images/generations",
	body: {
		model: "doubao-seedream-5-5",
		prompt: "Two paper kites in an open field",
		size: "1K",
		disable_nsfw: false,
		metadata: { background: "auto", output_format: "png", watermark: false },
	},
} as const;
const key = "toapis-fixture-key";
const taskId = "tsk_img_local_sample";

test("ToAPIs POST preserves the approved route flag and records the id", async () => {
	const image = createToapisImage(async (url, init) => {
		expect(url).toBe(request.url);
		expect(init).toMatchObject({
			method: "POST",
			body: JSON.stringify(request.body),
			redirect: "error",
		});
		expect(new Headers(init.headers).get("Authorization")).toBe("Bearer toapis-fixture-key");
		return Response.json({ id: taskId, object: "generation.task", status: "pending" });
	});
	expect(await image.submit(key, request)).toEqual({ kind: "accepted", taskId });
});

test("ToAPIs treats documented errors separately from transport or upstream uncertainty", async () => {
	for (const [code, reason] of [
		["invalid_request", "validation"],
		["invalid_image", "validation"],
		["invalid_image_file", "validation"],
		["invalid_private_assets", "validation"],
		["insufficient_user_quota", "quota"],
		["prompt_blocked", "filtering"],
		["do_request_failed", null],
		["pre_consume_token_quota_failed", null],
	] as const) {
		const image = createToapisImage(async () =>
			Response.json({ error: { code, message: "private response" } }, { status: 400 }),
		);
		expect(await image.submit(key, request)).toEqual(
			reason ? { kind: "rejected", reason } : { kind: "unknown" },
		);
	}
	const unavailable = createToapisImage(async () => {
		throw new Error("sensitive network diagnostics");
	});
	expect(await unavailable.submit(key, request)).toEqual({ kind: "unknown" });
});

test.each(["invalid_request", "invalid_image_file"])(
	"ToAPIs keeps timeout, rate-limit, upstream and contradictory %s responses uncertain",
	async (code) => {
		const error = { code };
		for (const [status, body] of [
			[408, { error }],
			[429, { error }],
			[503, { error }],
			[400, { error, id: taskId }],
			[400, { error, id: "invalid/id" }],
			[400, { error, id: "" }],
			[400, { error, id: 42 }],
			[400, { error, id: null }],
			[400, { error, success: true }],
			[400, { error, object: "generation.task" }],
			[400, { error, status: "pending" }],
			[200, { id: taskId, success: false }],
			[200, { id: taskId, error }],
		] as const) {
			const image = createToapisImage(async () => Response.json(body, { status }));
			expect(await image.submit(key, request)).toEqual({ kind: "unknown" });
		}
		const timedOut = createToapisImage(async () => {
			throw new DOMException("private request details", "TimeoutError");
		});
		expect(await timedOut.submit(key, request)).toEqual({ kind: "unknown" });
	},
);

test("ToAPIs preserves exact decimal settlement and expiry without retaining response details", async () => {
	const credits = "100.0000000001";
	const url = "https://cdn.example.org/generated/locally-created.jpg?sig=fixture";
	const image = createToapisImage(async (endpoint) => {
		expect(endpoint).toBe(`${request.url}/${taskId}`);
		return Response.json({
			id: taskId,
			status: "completed",
			expires_at: 1_799_900_000,
			result: { type: "image", data: [{ url }] },
			billing: { status: "settled", credits, cost_usd: "0.50000000005" },
			metadata: { echoedPrompt: "don't retain" },
		});
	});
	expect(await image.status(key, taskId)).toMatchObject({
		kind: "observed",
		state: "completed",
		billing: { status: "settled", credits, usd: "0.50000000005" },
		resultUrl: url,
		expiresAt: 1_799_900_000_000,
	});
});

test("ToAPIs recognizes pending without a charge and failed with a confirmed refund", async () => {
	for (const [body, expected] of [
		[
			{ status: "pending", billing: { status: "pending", credits: "123" } },
			{
				state: "waiting",
				billing: { status: "unknown" },
			},
		],
		[
			{
				status: "failed",
				error: { message: "private response" },
				billing: {
					status: "refunded",
					credits: "0",
					cost_usd: "0",
				},
			},
			{
				state: "failed",
				billing: { status: "refunded", credits: "0", usd: "0" },
			},
		],
	] as const) {
		const image = createToapisImage(async () => Response.json({ id: taskId, ...body }));
		expect(await image.status(key, taskId)).toMatchObject({ kind: "observed", ...expected });
	}
});

test("ToAPIs exposes only the bounded reason from a matching failed task", async () => {
	const error = {
		code: "generation_failed",
		reason: "reference_media_unreadable",
		input_media_errors: [{ message: "https://ref.example.net/private.png?sig=private" }],
	};
	const failed = createToapisImage(async () =>
		Response.json({ id: taskId, status: "failed", error }),
	);
	expect(await failed.status(key, taskId)).toEqual({
		kind: "observed",
		state: "failed",
		failureReason: "reference_media_unreadable",
		billing: { status: "unknown" },
		resultUrl: null,
		expiresAt: null,
		retryAfter: null,
	});
	const unrelated = createToapisImage(async () =>
		Response.json({ id: "different-task", status: "failed", error }),
	);
	expect(await unrelated.status(key, taskId)).toEqual({ kind: "temporary", retryAfter: null });
	const running = createToapisImage(async () =>
		Response.json({ id: taskId, status: "in_progress", error }),
	);
	expect(await running.status(key, taskId)).toEqual({ kind: "temporary", retryAfter: null });
});
