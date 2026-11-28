import { inventoryAction } from "#lib/server/services/providers/inventory-http.ts";
import type { RequestHandler } from "./$types";
export const POST: RequestHandler = (event) => inventoryAction(event);
