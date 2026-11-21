import { queueAction } from "#lib/server/services/queue/http.ts";
import type { RequestHandler } from "./$types";
export const POST: RequestHandler = (event) => queueAction(event, "review");
