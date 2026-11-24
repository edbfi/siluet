import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";

/** The cleaning setting and its revision, for a tab deciding whether its copy is stale. */
export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.owner) error(404);
	const setting = await locals.studio.cleaning.read().catch(() => null);
	if (!setting) error(503);
	return json(setting, { headers: { "cache-control": "no-store" } });
};
