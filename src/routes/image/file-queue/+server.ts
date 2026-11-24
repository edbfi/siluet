import { fileAction } from "#lib/server/services/file-edit/http.ts";
import type { RequestHandler } from "./$types";
export const POST: RequestHandler = (event) => fileAction(event, "submit");
