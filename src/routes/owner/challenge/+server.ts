import type { RequestHandler } from "./$types";

export const POST: RequestHandler = ({ locals, request }) =>
	locals.studio.browserSessions.challenge(request);
