import type { ClientInit } from "@sveltejs/kit/hooks";
import { authenticatedFetch } from "#lib/shared/owner/authenticated-fetch.ts";
import { isInstallationId } from "#lib/shared/owner/key-store.ts";
import { createSessionClient, setSessionClient } from "#lib/shared/owner/session-client.ts";

/**
 * Install the browser-key session before the first load. The page shell names its
 * installation; without a valid ID the tab touches no key storage and sends no private request.
 */
export const init: ClientInit = () => {
	const meta = document.querySelector('meta[name="siluet-installation"]')?.getAttribute("content");
	const installation = isInstallationId(meta) ? meta : null;
	// SvelteKit's own wrapper, which keeps its load cache and dev checks.
	const native = window.fetch;
	const client = createSessionClient(installation, native);
	setSessionClient(client);
	const authenticated = authenticatedFetch(client, native);
	const wrapped = (input: RequestInfo | URL, init?: RequestInit) => {
		if (installation) return authenticated(input, init);
		const url = new URL(input instanceof Request ? input.url : String(input), location.href);
		return url.origin === location.origin
			? Promise.reject(new TypeError("Siluet could not identify this installation."))
			: native(input, init);
	};
	window.fetch = Object.assign(wrapped, { preconnect: native.preconnect });
};
