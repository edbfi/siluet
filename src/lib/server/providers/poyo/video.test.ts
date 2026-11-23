import { describe, expect, test } from "bun:test";
import { createPoyoVideo } from "./video";

// Fresh fixtures from the H3 Max, status and error-code pages:
// https://docs.poyo.ai/api-manual/video-series/h3-max.md
// https://docs.poyo.ai/api-manual/task-management/video-status.md
// https://docs.poyo.ai/api-manual/error-codes
const body = {
	model: "h3-max",
	input: {
		prompt: "A wave breaks.",
		duration: 5,
		resolution: "768p",
		aspect_ratio: "16:9",
		enable_safety_checker: false,
	},
};
const task = "wave_1";
const url = "https://media.example.org/wave.mp4";
const reply =
	(value: unknown, status = 200, headers?: HeadersInit) =>
	async () =>
		typeof value === "string"
			? new Response(value, { status, headers })
			: Response.json(value, { status, headers });
const error = (code: number, type: string) => ({
	code,
	error: { type, message: "DO NOT STORE the prompt echo" },
});

test("H3 submits the reviewed body once with the Bearer key", async () => {
	const calls: RequestInit[] = [];
	const video = createPoyoVideo(async (address, init) => {
		expect(address).toBe("https://api.poyo.ai/api/generate/submit");
		calls.push(init);
		return Response.json({
			code: 200,
			data: { task_id: task, status: "not_started", created_time: "2026-11-22T00:00:00" },
		});
	});
	expect(await video.submit("fixture", body)).toEqual({ kind: "accepted", taskId: task });
	expect(calls).toHaveLength(1);
	expect(calls[0].method).toBe("POST");
	expect(calls[0].redirect).toBe("error");
	expect(JSON.parse(String(calls[0].body))).toEqual(body);
	expect(new Headers(calls[0].headers).get("authorization")).toBe("Bearer fixture");
});

describe("submit outcomes", () => {
	test.each([
		["ID-only acknowledgement", reply({ code: 200, data: { task_id: task } }), "accepted"],
		["HTTP 400 validation", reply(error(400, "validation_error"), 400), "validation"],
		["HTTP 200 code 400", reply(error(400, "invalid_request_error")), "validation"],
		["content too long", reply(error(400, "content_too_long_error"), 400), "validation"],
		["file format", reply(error(400, "file_format_error"), 400), "validation"],
		["content moderation", reply(error(400, "content_moderation_error"), 400), "filtering"],
		["401 authentication", reply(error(401, "authentication_error"), 401), "authorization"],
		["402 insufficient credits", reply(error(402, "insufficient_credits_error"), 402), "quota"],
		["403 permission_denied", reply(error(403, "permission_denied_error"), 403), "permission"],
	] as const)("%s", async (_name, fetch, expected) => {
		const result = await createPoyoVideo(fetch).submit("fixture", body);
		expect(result).toEqual(
			expected === "accepted"
				? { kind: "accepted", taskId: task }
				: { kind: "rejected", reason: expected },
		);
		expect(JSON.stringify(result)).not.toContain("DO NOT STORE");
	});

	test.each([
		[
			"timeout",
			async () => {
				throw new DOMException("timed out", "TimeoutError");
			},
		],
		["HTTP 408", reply(error(408, "request_timeout"), 408)],
		["HTTP 500", reply(error(500, "internal_error"), 500)],
		["HTTP 502", reply("bad gateway", 502)],
		["HTTP 503", reply(error(503, "service_unavailable"), 503)],
		["business 503 on HTTP 200", reply(error(503, "upstream_error"))],
		["submit 404", reply(error(404, "not_found_error"), 404)],
		["unknown error type", reply(error(400, "unexpected_error"), 400)],
		["status/code mismatch", reply(error(403, "permission_denied_error"), 400)],
		["malformed JSON", reply("{not json")],
		["empty body", reply("")],
		[
			"task evidence beside an error",
			reply({ ...error(400, "validation_error"), data: { task_id: task } }),
		],
		[
			"error inside an acknowledgement",
			reply({ code: 200, data: { task_id: task, error: { type: "x" } } }),
		],
		[
			"error message inside an acknowledgement",
			reply({ code: 200, data: { task_id: task, error_message: "x" } }),
		],
		["invalid task ID", reply({ code: 200, data: { task_id: "bad id" } })],
		["429 on HTTP 200", reply(error(429, "rate_limit_error"))],
		[
			"429 with task evidence",
			reply({ ...error(429, "rate_limit_error"), data: { task_id: task } }, 429),
		],
	] as const)("%s stays uncertain", async (_name, fetch) => {
		expect(await createPoyoVideo(fetch).submit("fixture", body)).toEqual({ kind: "unknown" });
	});

	test("the Poyo limiter signature throttles and keeps Retry-After", async () => {
		const fetch = reply(error(429, "rate_limit_error"), 429, { "Retry-After": "17" });
		expect(await createPoyoVideo(fetch).submit("fixture", body)).toEqual({
			kind: "throttled",
			retryAfter: "17",
		});
	});
});

describe("status", () => {
	const status = (value: unknown, http = 200) =>
		createPoyoVideo(reply(value, http, { "Retry-After": "30" })).status("fixture", task);
	const finished = (data: Record<string, unknown>) =>
		status({ code: 200, data: { task_id: task, status: "finished", ...data } });

	test("one video file of the acknowledged task completes with provider-reported credits", async () => {
		for (const [credits, billing] of [
			[undefined, null],
			[0, { status: "reported", credits: "0" }],
			[78.5, { status: "reported", credits: "78.5" }],
			[-1, null],
			["80", null],
		] as const)
			expect(
				await finished({ files: [{ file_type: "video", file_url: url }], credits_amount: credits }),
			).toEqual({
				kind: "observed",
				state: "completed",
				failureReason: null,
				billing,
				resultUrl: url,
				expiresAt: null,
				retryAfter: "30",
			});
	});

	test("missing, multiple, mixed or image files leave the result unavailable", async () => {
		const media = { file_type: "video", file_url: url };
		for (const files of [
			[media, media],
			[media, { file_type: "image", file_url: url }],
			[{ file_type: "image", file_url: url }],
		])
			expect(await finished({ files })).toMatchObject({
				state: "completed",
				resultUrl: null,
				unsupportedVideoResult: true,
			});
		for (const files of [
			undefined,
			[],
			[{ file_type: "video" }],
			[{ ...media, file_url: "http://x.test/a" }],
		])
			expect(await finished({ files })).toMatchObject({ state: "completed", resultUrl: null });
	});

	test("states map, failure messages are discarded and identity must match", async () => {
		for (const [state, expected] of [
			["not_started", "waiting"],
			["running", "running"],
			["failed", "failed"],
		]) {
			const observation = await status({
				code: 200,
				data: { task_id: task, status: state, error_message: "private upstream echo" },
			});
			expect(observation).toMatchObject({ kind: "observed", state: expected, resultUrl: null });
			expect(JSON.stringify(observation)).not.toContain("private upstream echo");
		}
		expect(await status({ code: 200, data: { task_id: "other", status: "finished" } })).toEqual({
			kind: "paused",
			reason: "unknown-status",
			retryAfter: "30",
		});
		expect(await status({ code: 200, data: { task_id: task, status: "queued" } })).toMatchObject({
			kind: "paused",
			reason: "unknown-status",
		});
	});

	test("access, missing task and temporary failures", async () => {
		for (const [value, http] of [
			[{ code: 401 }, 401],
			[{ code: 403 }, 403],
			[{ code: 401 }, 200],
			[{ code: 403 }, 200],
		] as const)
			expect(await status(value, http)).toMatchObject({ kind: "paused", reason: "authorization" });
		expect(await status({ code: 404 }, 404)).toMatchObject({
			kind: "paused",
			reason: "missing-task",
		});
		expect(await status({ code: 404 })).toMatchObject({ kind: "paused", reason: "missing-task" });
		for (const [value, http] of [
			[{ code: 429 }, 429],
			[{ code: 429 }, 200],
			[{ code: 408 }, 408],
			[{ code: 500 }, 500],
			[{ code: 503 }, 200],
			["{bad", 200],
			[{ ...error(400, "x"), code: 200, data: { task_id: task, status: "finished" } }, 200],
		] as const)
			expect(await status(value, http)).toEqual({ kind: "temporary", retryAfter: "30" });
		expect(
			await createPoyoVideo(async () => {
				throw new Error("offline");
			}).status("fixture", task),
		).toMatchObject({ kind: "temporary" });
		expect(await createPoyoVideo(reply({})).status("fixture", "bad id")).toMatchObject({
			kind: "paused",
			reason: "missing-task",
		});
	});
});
