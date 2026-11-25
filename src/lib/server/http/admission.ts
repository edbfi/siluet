import type { RequestEvent } from "@sveltejs/kit";
import type { ResolveOptions } from "@sveltejs/kit/hooks";
import { AccessError } from "../services/owner/access-error";
import { accessBody, accessPage } from "../services/owner/access-response";
import type { StudioRuntime } from "../services/owner/runtime";
import { legacyCookieDeletions } from "./legacy-cookies";

/** Every route with a `+page.svelte`. A test keeps this equal to the route tree. */
export const pageRoutes: ReadonlySet<string> = new Set([
	"/",
	"/gallery",
	"/gallery/[jobId]",
	"/gallery/[jobId]/remove",
	"/image",
	"/jobs",
	"/settings/files",
	"/settings/providers",
	"/settings/security",
	"/setup",
	"/sign-in",
	"/video",
]);
/** Browser-key endpoints. They verify their own signature, then check access. */
export const signedRoutes: ReadonlySet<string> = new Set([
	"/owner/challenge",
	"/owner/claim",
	"/owner/sign-in",
	"/owner/factor",
	"/owner/resume",
	"/owner/sign-out",
]);

export type Admission = "document" | "health" | "signed" | "public-data" | "private";
/**
 * Which row of the admission matrix a request falls in. Documents are public shells with no
 * private data; everything else needs a bearer unless it is listed here.
 */
export function classify(method: string, route: string | null, isDataRequest: boolean): Admission {
	const read = method === "GET" || method === "HEAD";
	if (route === "/healthz") return "health";
	if (read && !isDataRequest && (route === null || pageRoutes.has(route))) return "document";
	if (method === "POST" && route !== null && signedRoutes.has(route)) return "signed";
	if (read && isDataRequest && (route === "/setup" || route === "/sign-in")) return "public-data";
	return "private";
}

/** A form action, as SvelteKit's `enhance` posts it. */
const isAction = (event: RequestEvent) =>
	event.request.method === "POST" && event.route.id !== null && pageRoutes.has(event.route.id);
const bearerOf = (request: Request) => {
	const header = request.headers.get("authorization");
	return header?.startsWith("Bearer ") ? header.slice(7) : null;
};

type Studio = Pick<
	StudioRuntime,
	"access" | "checkAccess" | "hasOwner" | "origin" | "installationId"
>;
type Resolve = (event: RequestEvent, options?: ResolveOptions) => Response | Promise<Response>;

export async function admit(
	event: RequestEvent,
	resolve: Resolve,
	studio: Studio,
	headers: Record<string, string>,
) {
	const { request, route, locals } = event;
	const json = (body: unknown, status: number, extra: Record<string, string> = {}) =>
		new Response(JSON.stringify(body), {
			status,
			headers: { ...headers, ...extra, "content-type": "application/json" },
		});
	// Page and 404 shells carry the installation ID, which the client checks before its key.
	const pages: ResolveOptions = {
		transformPageChunk: ({ html }) => html.replace("%siluet.installation%", studio.installationId),
	};
	const kind = classify(request.method, route.id, event.isDataRequest);
	locals.studio = studio as StudioRuntime;
	locals.session = null;
	locals.owner = null;
	if (kind === "health" || kind === "signed") return resolve(event);
	try {
		await studio.checkAccess();
	} catch (error) {
		if (!(error instanceof AccessError)) throw error;
		if (kind === "document") {
			// Built from fixed keys, never the raw query. Setup's offer survives the retry.
			const offer = event.url.searchParams.has("offer");
			const retry =
				route.id === "/settings/security"
					? `/settings/security${offer ? "?offer" : ""}`
					: route.id === "/settings/files"
						? `/settings/files${offer ? "?offer" : ""}`
						: "/";
			return new Response(accessPage(error, retry), {
				status: error.status,
				headers: { ...headers, "content-type": "text/html; charset=utf-8" },
			});
		}
		const body = accessBody(error);
		return json(isAction(event) ? { type: "error", error: body } : body, error.status);
	}
	if (kind === "document") {
		if (route.id === "/setup" && (await studio.hasOwner()))
			return new Response("Not Found", { status: 404, headers });
		const response = await resolve(event, pages);
		response.headers.set("cross-origin-opener-policy", "same-origin");
		for (const cookie of legacyCookieDeletions(
			request.headers.get("cookie"),
			studio.installationId,
			studio.origin.port,
		))
			response.headers.append("set-cookie", cookie);
		return response;
	}
	const bearer = bearerOf(request);
	// GET /owner/session reads its session without marking activity.
	const session =
		route.id === "/owner/session"
			? await studio.access.peek(bearer)
			: await studio.access.session(bearer);
	locals.session = session;
	locals.owner = session?.username ?? null;
	if (kind === "public-data") {
		if (route.id === "/setup" && (await studio.hasOwner()))
			return new Response("Not Found", { status: 404, headers });
		return resolve(event, pages);
	}
	if (!session) {
		const location = (await studio.hasOwner()) ? "/sign-in" : "/setup";
		const challenge = { "www-authenticate": `Bearer${bearer ? ' error="invalid_token"' : ""}` };
		return isAction(event)
			? json({ type: "redirect", status: 303, location }, 401, challenge)
			: json({ message: "Sign in to open the studio.", location }, 401, challenge);
	}
	return resolve(event, pages);
}
