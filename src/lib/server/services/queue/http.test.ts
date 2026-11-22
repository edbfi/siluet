import { expect, test } from "bun:test";
import type { RequestEvent } from "@sveltejs/kit";
import { createSeedreamDraft } from "../../../shared/image-studio/seedream";
import { queueAction } from "./http";

const body = {
	draft: { ...createSeedreamDraft("poyo"), prompt: "a folding screen" },
	count: 1,
	retryLimit: 0,
	acceptUnknown: false,
	token: "reviewed-token",
};

function post(result: object) {
	const submitted: unknown[] = [];
	const event = {
		request: new Request("http://studio.test/image/queue", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		}),
		locals: {
			owner: "owner",
			studio: {
				queue: {
					submit: async (_owner: string, input: unknown) => {
						submitted.push(input);
						return result;
					},
				},
			},
		},
	} as unknown as RequestEvent;
	return { response: queueAction(event, "submit"), submitted };
}

test("cooldown → 429 with until", async () => {
	const until = 1_800_000_000_000;
	const { response, submitted } = post({ error: "cooldown", until });
	const answer = await response;
	expect(answer.status).toBe(429);
	expect(await answer.json()).toEqual({ error: "cooldown", until });
	expect(submitted).toHaveLength(1);
});

test.each([
	[{ error: "stale" }, 409],
	[{ error: "invalid" }, 400],
	[{ jobId: "job-1" }, 200],
])("other submission results keep their status (%o → %i)", async (result, status) => {
	expect((await post(result).response).status).toBe(status);
});
