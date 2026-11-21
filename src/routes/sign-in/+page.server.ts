import { authenticate } from "#lib/server/services/owner/form.ts";
import type { Actions } from "./$types";
export const actions = { default: (event) => authenticate(event, false) } satisfies Actions;
