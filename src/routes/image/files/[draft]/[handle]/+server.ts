import { stagedMedia } from "#lib/server/services/file-edit/http.ts";
import type { RequestHandler } from "./$types";
export const GET: RequestHandler = (event) => stagedMedia(event, false);
export const POST: RequestHandler = (event) => stagedMedia(event, true);
