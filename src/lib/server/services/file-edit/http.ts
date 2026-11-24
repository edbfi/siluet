import { json, type RequestEvent } from "@sveltejs/kit";
import type { CleaningSetting } from "../../../shared/media-staging/cleaning";
import { privateMediaResponse } from "../media/private-response";
import { PreparationError } from "../media-cleanup/preparation";
import { opaqueId } from "../media-staging/opaque-id";
import { CleaningChangedError, maxStageBytes, StageError } from "../media-staging/stages";
import { sessionDigest } from "../owner/credentials";
import { parseFileRequest } from "./request";

const settingFields = (setting: CleaningSetting | null) => ({
	enabled: setting?.enabled ?? null,
	revision: setting?.revision ?? null,
});

function scopeFor({ locals, cookies }: RequestEvent, draft: unknown) {
	const token = cookies.get(locals.studio.cookieName);
	return locals.owner && token && opaqueId(draft)
		? { owner: locals.owner, session: sessionDigest(token), draft }
		: null;
}

/**
 * Prepare one local image and stage the verified copy for this owner, session and
 * draft. Staging makes no provider calls and works with no provider connected.
 */
export async function stageFile(event: RequestEvent) {
	const { locals, request, params } = event;
	const scope = scopeFor(event, params.draft);
	if (!scope || !request.body) return json({ error: "Unavailable." }, { status: 400 });
	if (request.headers.get("content-type") !== "application/octet-stream")
		return new Response(null, { status: 415 });
	const declared = request.headers.get("content-length");
	if (declared && (!/^\d+$/.test(declared) || Number(declared) > maxStageBytes))
		return new Response(null, { status: 413 });
	const token = event.cookies.get(locals.studio.cookieName);
	// The setting this preparation was admitted under, so another tab can tell when a
	// change in Settings made this copy or refusal stale and describe the current mode.
	let admitted: CleaningSetting | null = null;
	const current = async () =>
		settingFields(admitted ?? (await locals.studio.cleaning.read().catch(() => null)));
	try {
		const stage = await locals.studio.prepareMedia(
			request.body,
			request.signal,
			(media, stop) =>
				locals.studio.stages.put(scope, media, {
					...stop,
					valid: async () => (await locals.studio.access.session(token)) === scope.owner,
				}),
			(setting) => {
				admitted = setting;
			},
		);
		return json({ stage, ...settingFields(admitted) });
	} catch (error) {
		if (error instanceof CleaningChangedError)
			return json(
				{
					error: "The cleaning setting changed.",
					code: "cleaning-changed",
					...settingFields(await locals.studio.cleaning.read().catch(() => null)),
				},
				{ status: 409 },
			);
		const [code, message] =
			error instanceof PreparationError
				? [error.code, `${error.message} ${error.advice}`]
				: error instanceof StageError
					? ["stage", error.message]
					: ["unavailable", "Image preparation unavailable."];
		return json({ error: message, code, ...(await current()) }, { status: 422 });
	}
}

/** Discard every copy of this draft, including one from a request the browser abandoned. */
export async function discardDraft(event: RequestEvent) {
	const scope = scopeFor(event, event.params.draft);
	if (!scope) return new Response(null, { status: 404 });
	await event.locals.studio.stages.discardDraft(scope);
	return new Response(null, { status: 204 });
}

export async function stagedPreview(event: RequestEvent) {
	const scope = scopeFor(event, event.params.draft);
	const handle = event.params.handle;
	if (!scope || !opaqueId(handle)) return new Response(null, { status: 404 });
	const lease = await event.locals.studio.stages.openPreview(scope, handle).catch(() => null);
	if (!lease) return new Response(null, { status: 404 });
	return privateMediaResponse(event.request, lease);
}

const statusFor = {
	busy: 503,
	closing: 503,
	unavailable: 503,
	stale: 409,
	cooldown: 409,
	limit: 413,
	invalid: 400,
} as const;

/** Review or Queue one staged file for a Seedream edit. */
export async function fileAction(event: RequestEvent, operation: "review" | "submit") {
	if (event.request.headers.get("content-type")?.split(";")[0] !== "application/json")
		return json({ error: "invalid" }, { status: 415 });
	const live = parseFileRequest(await event.request.json().catch(() => null));
	const scope = scopeFor(event, live?.stage.draft);
	if (!scope || !live) return json({ error: "invalid" }, { status: 400 });
	const result = await event.locals.studio.files[operation](scope, live);
	return json(result, { status: "error" in result ? statusFor[result.error] : 200 });
}
