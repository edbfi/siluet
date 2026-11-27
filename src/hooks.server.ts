import type { Handle, HandleServerError, ServerInit } from "@sveltejs/kit/hooks";
import { admit as admitOwner } from "#lib/server/http/admission.ts";
import { withSecurityHeaders } from "#lib/server/http/security-headers.ts";
import { requireSupportedPlatform } from "#lib/server/platform.ts";
import { ordinaryRequest } from "#lib/server/services/owner/request-limit.ts";
import type { StudioRuntime } from "#lib/server/services/owner/runtime.ts";
import { building, dev } from "$app/env";

let studio: StudioRuntime;
export const init: ServerInit = async () => {
	if (building) return;
	// Refuse before the runtime loads its native bindings.
	requireSupportedPlatform();
	// Storage, Gallery and scratch files are the owner's alone, also under `vite dev`.
	process.umask(0o077);
	const { initializeOwner } = await import("#lib/server/services/owner/runtime.ts");
	studio = await initializeOwner(dev);
};
const failure = "The studio could not complete the request.";
const reportFailure = (route: string | null) =>
	console.error("Studio request failed on route", route ?? "(unmatched)");
export const handleError: HandleServerError = ({ event, kind }) => {
	if (kind !== "unknown") return;
	reportFailure(event.route.id);
	return { message: failure };
};
// Every response from this hook, including a failure SvelteKit would otherwise render
// without hooks, carries the framing, sniffing and referrer headers.
export const handle: Handle = async (input) => {
	try {
		return withSecurityHeaders(await admit(input));
	} catch {
		reportFailure(input.event.route.id);
		return withSecurityHeaders(
			new Response(failure, { status: 500, headers: { "cache-control": "no-store" } }),
		);
	}
};
const admit: Handle = async ({ event, resolve }) => {
	const { request, route } = event;
	studio.watchServer(event.platform?.server);
	const headers: Record<string, string> = {
		"cache-control":
			route.id === "/gallery/[jobId]/media" || route.id === "/image/files/[draft]/[handle]"
				? "private, no-store"
				: "no-store",
	};
	const deny = (status: number) =>
		new Response(`Open the studio at ${studio.origin.origin}/.`, { status, headers });
	const read = request.method === "GET" || request.method === "HEAD";
	if (
		request.headers.get("host") !== studio.origin.host ||
		(!read && request.headers.get("origin") !== studio.origin.origin)
	)
		return deny(403);
	if (route.id?.startsWith("/image/files/")) {
		// Staged copies are private to this origin, including previews loaded by GET.
		const origin = request.headers.get("origin");
		const site = request.headers.get("sec-fetch-site");
		if (
			(origin !== null && origin !== studio.origin.origin) ||
			(site !== null && site !== "same-origin" && site !== "none")
		)
			return deny(403);
	}
	// The listener accepts 32,000,000 bytes for image staging only. Keep 512 KiB elsewhere,
	// for declared and streamed bodies.
	const staging = request.method === "POST" && route.id === "/image/files/[draft]";
	const bounded = staging ? request : await ordinaryRequest(request);
	if (!bounded) return new Response(null, { status: 413, headers });
	const boundedEvent = bounded === request ? event : { ...event, request: bounded };
	event.setHeaders(headers);
	return admitOwner(boundedEvent, resolve, studio, headers);
};
