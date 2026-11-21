import type { StudioRuntime } from "./lib/server/services/owner/runtime";

declare global {
	namespace App {
		interface Locals {
			studio: StudioRuntime;
			owner: string | null;
		}
	}
}
