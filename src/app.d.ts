import type { OwnerSession } from "./lib/server/services/owner/access";
import type { StudioRuntime } from "./lib/server/services/owner/runtime";

declare global {
	namespace App {
		interface Locals {
			studio: StudioRuntime;
			/** The bearer's live session, set by the server hook for private requests. */
			session: OwnerSession | null;
			/** The session's owner username. */
			owner: string | null;
		}
		interface Error {
			message: string;
			/** Where a signed-out tab goes next. */
			location?: string;
			retry?: boolean;
			recoveryRequired?: boolean;
		}
	}
}
