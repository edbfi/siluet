import type { Handle, HandleServerError, ServerInit } from "@sveltejs/kit/hooks";
import { AccessError, recoverMessage } from "#lib/server/services/owner/access-error.ts";
import { securityNotice } from "#lib/server/services/owner/cookies.ts";
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
	const headers: Record<string, string> = {
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
	try {
		await studio.checkAccess();
	} catch (e) {
		if (e instanceof AccessError) {
			if (cookies.get(studio.cookieName))
				headers["set-cookie"] = cookies.serialize(...securityNotice(studio.origin));
			const retry = route.id === "/settings/security" ? "/settings/security?resume" : "/";
			const detail =
				e.status === 403
					? "Security settings changed."
					: "Authenticator storage is temporarily unavailable.";
			const message =
				e.message === recoverMessage ? recoverMessage : `${detail} <a href="${retry}">Retry</a>`;
			return new Response(
				`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Studio access · Siluet</title><main><h1>Studio access</h1><p>${message}</p></main></html>`,
				{ status: e.status, headers: { ...headers, "content-type": "text/html; charset=utf-8" } },
			);
		}
		throw e;
	}
	event.setHeaders(headers);
	locals.studio = studio;
	locals.owner = await studio.access.session(cookies.get(studio.cookieName));
	if (!locals.owner && cookies.get(studio.cookieName) && route.id !== "/sign-in")
		headers["set-cookie"] = cookies.serialize(...securityNotice(studio.origin));
	const claimed = locals.owner !== null || (await studio.hasOwner());
	if (claimed && route.id === "/setup") return deny(404);
	if (!claimed && route.id !== "/setup") return read ? move("/setup") : deny(403);
	if (claimed && !locals.owner && route.id !== "/sign-in")
		return read ? move("/sign-in") : deny(401);
	if (locals.owner && route.id === "/sign-in") return read ? move("/") : deny(403);
	return resolve(event);
};
