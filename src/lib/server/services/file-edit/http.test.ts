import { expect, test } from "bun:test";
import type { RequestEvent } from "@sveltejs/kit";
import type { CleaningSetting } from "../../../shared/media-staging/cleaning";
import type { PreparationStop, PreparedMedia } from "../media-cleanup/preparation";
import { PreparationError } from "../media-cleanup/preparation-bytes";
import { CleaningChangedError, StageError } from "../media-staging/stages";
import { stageFile } from "./http";

const draft = crypto.randomUUID();
const descriptor = {
	mime: "image/png",
	transform: "original",
	draft,
	handle: crypto.randomUUID(),
	digest: "a".repeat(64),
	size: 3,
	deadline: 1_800_000_000_000,
};

function event(
	outcome: () => Promise<unknown>,
	{ admitted = { enabled: false, revision: 4 }, current = { enabled: true, revision: 5 } } = {},
) {
	const request = new Request(`https://studio.test/image/files/${draft}`, {
		method: "POST",
		headers: { "content-type": "application/octet-stream" },
		body: new Uint8Array([1, 2, 3]),
	});
	const studio = {
		cookieName: "siluet_test",
		access: { session: async () => "creator" },
		cleaning: { read: async () => current },
		stages: { put: async () => descriptor },
		async prepareMedia(
			_body: unknown,
			_signal: AbortSignal,
			commit: (media: PreparedMedia, stop: PreparationStop) => Promise<unknown>,
			noted?: (setting: CleaningSetting | null) => void,
		) {
			noted?.(admitted);
			const result = await outcome();
			return result === "commit"
				? commit({} as PreparedMedia, { signal: request.signal, deadline: Infinity })
				: result;
		},
	};
	return {
		request,
		params: { draft },
		locals: { owner: "creator", studio },
		cookies: { get: () => "token" },
	} as unknown as RequestEvent;
}

test("a staged copy carries the admission setting beside its seven-key descriptor", async () => {
	const response = await stageFile(event(async () => "commit"));
	expect(response.status).toBe(200);
	expect(await response.json()).toEqual({ stage: descriptor, enabled: false, revision: 4 });
});

test("a refusal carries the admission setting", async () => {
	const response = await stageFile(
		event(async () => {
			throw new PreparationError("declined", ["The PNG contains trailing data.", "Export again."]);
		}),
	);
	expect(response.status).toBe(422);
	expect(await response.json()).toEqual({
		error: "The PNG contains trailing data. Export again.",
		code: "declined",
		enabled: false,
		revision: 4,
	});
});

test("a refusal before the setting was read carries the current setting", async () => {
	const response = await stageFile(
		event(
			async () => {
				throw new StageError("Local scratch full");
			},
			{ admitted: null as unknown as CleaningSetting },
		),
	);
	expect(await response.json()).toMatchObject({ code: "stage", enabled: true, revision: 5 });
});

test("a copy overtaken by a setting change answers 409 cleaning-changed", async () => {
	const response = await stageFile(
		event(async () => {
			throw new CleaningChangedError();
		}),
	);
	expect(response.status).toBe(409);
	expect(await response.json()).toMatchObject({
		code: "cleaning-changed",
		enabled: true,
		revision: 5,
	});
});
