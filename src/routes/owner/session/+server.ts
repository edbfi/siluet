import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";

/** The bearer's live session IDs. The hook read them without marking activity; nothing is issued. */
export const GET: RequestHandler = ({ locals }) => {
	const { sessionId, loginId } = locals.session ?? {};
	return json({ sessionId, loginId }, { headers: { "cache-control": "no-store" } });
};
