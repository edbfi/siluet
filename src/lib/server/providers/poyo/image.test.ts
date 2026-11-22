import { expect, test } from "bun:test";
import { createPoyoImage } from "./image";

const request = {
	method: "POST",
	url: "https://api.poyo.ai/api/generate/submit",
	body: {
		model: "seedream-5.5",
		input: {
			prompt: "A red bicycle against a white wall",
			size: "4:3",
			resolution: "1K",
			background: "opaque",
			output_format: "png",
			enable_safety_checker: false,
		},
	},
} as const;
const key = "poyo-fixture-key";
const taskId = "task-unified-1770080122-sample1";

test("Poyo POST uses the approved JSON and records the valid acknowledgement", async () => {
	const image = createPoyoImage(async (url, init) => {
		expect(url).toBe(request.url);
		expect(init).toMatchObject({
			method: "POST",
			body: JSON.stringify(request.body),
			redirect: "error",
		});
		expect(new Headers(init.headers).get("Authorization")).toBe("Bearer poyo-fixture-key");
		return Response.json({ code: 200, data: { task_id: taskId, status: "not_started" } });
	});
	expect(await image.submit(key, request)).toEqual({ kind: "accepted", taskId });
});

test("Poyo distinguishes business validation and quota rejection from an unknown submission", async () => {
	for (const [code, type, reason] of [
		[400, "invalid_request_error", "validation"],
		[400, "file_format_error", "validation"],
		[400, "content_moderation_error", "filtering"],
		[402, "insufficient_credits_error", "quota"],
	] as const) {
		const image = createPoyoImage(async () =>
			Response.json({ code, error: { type, message: "secret query and prompt" } }),
		);
		expect(await image.submit(key, request)).toEqual({ kind: "rejected", reason });
	}
	for (const body of [
		{ code: 200, data: { task_id: "../../unsafe" } },
		{ code: 400, error: { type: "upstream_error" } },
		{ code: 200, data: { status: "not_started" } },
	]) {
		const image = createPoyoImage(async () => Response.json(body));
		expect(await image.submit(key, request)).toEqual({ kind: "unknown" });
	}
	const upstream = createPoyoImage(async () =>
		Response.json({ code: 400, error: { type: "validation_error" } }, { status: 502 }),
	);
	expect(await upstream.submit(key, request)).toEqual({ kind: "unknown" });
});

test("Poyo keeps a file-format error with any task-ID field uncertain", async () => {
	for (const id of [taskId, "invalid/id", "", 42, null]) {
		const image = createPoyoImage(async () =>
			Response.json({ code: 400, data: { task_id: id }, error: { type: "file_format_error" } }),
		);
		expect(await image.submit(key, request)).toEqual({ kind: "unknown" });
	}
});

test("Poyo reads only image entries and separates task credits and wallet credits", async () => {
	const resultUrl = "https://media.example.net/pink-tile.png?signature=sample";
	const image = createPoyoImage(async (url) => {
		if (url.endsWith("/user/balance"))
			return Response.json({
				code: 200,
				data: { credits_amount: 90.25, email: "private@example.net" },
			});
		expect(url).toBe(`https://api.poyo.ai/api/generate/status/${taskId}`);
		return Response.json({
			code: 200,
			data: {
				task_id: taskId,
				status: "finished",
				credits_amount: 2.25,
				files: [
					{ file_type: "audio", file_url: "https://media.example.net/a.ogg" },
					{
						file_type: "image",
						file_url: resultUrl,
					},
				],
			},
		});
	});
	expect(await image.balance(key)).toBe("90.25");
	expect(await image.status(key, taskId)).toMatchObject({
		kind: "observed",
		state: "completed",
		billing: { status: "reported", credits: "2.25" },
		resultUrl,
	});
});

test("Poyo pauses missing or unknown tasks and retries upstream status errors", async () => {
	for (const [status, code, reason] of [
		[404, 200, "missing-task"],
		[200, 404, "missing-task"],
		[200, 403, "authorization"],
	] as const) {
		const image = createPoyoImage(async () => Response.json({ code, error: {} }, { status }));
		expect(await image.status(key, taskId)).toMatchObject({ kind: "paused", reason });
	}
	const image = createPoyoImage(async () =>
		Response.json({ code: 200, data: { task_id: taskId, status: "private-provider-status" } }),
	);
	expect(await image.status(key, taskId)).toMatchObject({
		kind: "paused",
		reason: "unknown-status",
	});
	const unavailable = createPoyoImage(
		async () => new Response(null, { status: 503, headers: { "Retry-After": "25" } }),
	);
	expect(await unavailable.status(key, taskId)).toMatchObject({
		kind: "temporary",
		retryAfter: "25",
	});
});

// https://docs.poyo.ai/#10-rate-limits-concurrency
test("only a consistent submit-limiter rejection authorizes a Poyo retry", async () => {
	const error = { type: "rate_limit_error", message: "fixture limiter" };
	const submit = (status: number, body: object) =>
		createPoyoImage(async () =>
			Response.json(body, { status, headers: { "retry-after": "12" } }),
		).submit(key, request);
	expect(await submit(429, { code: 429, error })).toEqual({ kind: "throttled", retryAfter: "12" });
	for (const extra of [
		{ success: true },
		{ task_id: taskId },
		{ data: { task_id: taskId } },
		{ data: { status: "running" } },
		{ error: { ...error, task_id: taskId } },
	])
		expect(await submit(429, { code: 429, error, ...extra })).toEqual({ kind: "unknown" });
	expect(await submit(503, { code: 429, error })).toEqual({ kind: "unknown" });
});
