import type { Handle, HandleServerError, ServerInit } from "@sveltejs/kit/hooks";
import { initializeOwner, type StudioRuntime } from "#lib/server/services/owner/runtime.ts";
import { building, dev } from "$app/env";

let studio: StudioRuntime;
export const init: ServerInit = async () => {
	if (!building) studio = await initializeOwner(dev);
};
export const handleError: HandleServerError = ({ event, kind }) => {
	if (kind !== "unknown") return;
	console.error("Studio request failed on route", event.route.id ?? "(unmatched)");
	return { message: "The studio could not complete the request." };
};
export const handle: Handle = async ({ event, resolve }) => {
	const { request, route, locals, cookies } = event;
	const headers = {
		"cache-control": route.id === "/gallery/[jobId]/media" ? "private, no-store" : "no-store",
	};
	const deny = (status: number) =>
		new Response(`Open the studio at ${studio.origin.origin}/.`, { status, headers });
	const move = (location: string) =>
		new Response(null, { status: 303, headers: { ...headers, location } });
	const read = request.method === "GET" || request.method === "HEAD";
	if (
		request.headers.get("host") !== studio.origin.host ||
		(!read && request.headers.get("origin") !== studio.origin.origin)
	)
		return deny(403);
	if (route.id === "/healthz") return resolve(event);
	event.setHeaders(headers);
	locals.studio = studio;
	locals.owner = await studio.access.session(cookies.get(studio.cookieName));
	const claimed = locals.owner !== null || (await studio.hasOwner());
	if (claimed && route.id === "/setup") return deny(404);
	if (!claimed && route.id !== "/setup") return read ? move("/setup") : deny(403);
	if (claimed && !locals.owner && route.id !== "/sign-in")
		return read ? move("/sign-in") : deny(401);
	if (locals.owner && route.id === "/sign-in") return read ? move("/") : deny(403);
	return resolve(event);
};
