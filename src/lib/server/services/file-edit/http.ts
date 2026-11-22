import { json, type RequestEvent } from "@sveltejs/kit";
import { privateMediaResponse } from "../media/private-response";
import { PreparationError } from "../media-cleanup/preparation";
import { opaqueId } from "../media-staging/opaque-id";
import { maxStageBytes, StageError } from "../media-staging/stages";
import { sessionDigest } from "../owner/credentials";

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
	try {
		const stage = await locals.studio.prepareMedia(request.body, request.signal, (media) =>
			locals.studio.stages.put(
				scope,
				media,
				async () =>
					!request.signal.aborted && (await locals.studio.access.session(token)) === scope.owner,
			),
		);
		return json(stage);
	} catch (error) {
		const [code, message] =
			error instanceof PreparationError
				? [error.code, `${error.message} ${error.advice}`]
				: error instanceof StageError
					? ["stage", error.message]
					: ["unavailable", "Image preparation unavailable."];
		return json({ error: message, code }, { status: 422 });
	}
}

export async function stagedMedia(event: RequestEvent, discard: boolean) {
	const scope = scopeFor(event, event.params.draft);
	const handle = event.params.handle;
	if (!scope || !opaqueId(handle)) return new Response(null, { status: 404 });
	if (discard) {
		await event.locals.studio.stages.discard(scope, handle);
		return new Response(null, { status: 204 });
	}
	const lease = await event.locals.studio.stages.openPreview(scope, handle).catch(() => null);
	if (!lease) return new Response(null, { status: 404 });
	return privateMediaResponse(event.request, lease);
}
