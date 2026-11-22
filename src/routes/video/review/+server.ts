import { videoAction } from "#lib/server/services/queue/video-http.ts";
import type { RequestHandler } from "./$types";
export const POST: RequestHandler = (event) => videoAction(event, "review");
