/**
 * Headers every studio response carries. Pages get their full policy from `kit.csp`
 * in vite.config.ts; anything else that reaches the browser renders no content of its own.
 */
const baseline = {
	"x-frame-options": "DENY",
	"x-content-type-options": "nosniff",
	// Not no-referrer: browsers then send `Origin: null` on POSTs, including the page's own
	// fetches, which the hook's exact Origin check refuses. same-origin still sends nothing to
	// other sites.
	"referrer-policy": "same-origin",
};

/**
 * Endpoints, redirects, refusals and the access page: plain text, JSON or fixed markup.
 * SvelteKit's static error page, used for an endpoint error opened in a tab, styles
 * itself with an inline <style> block, so inline styles are allowed. Scripts are not.
 */
export const responsePolicy =
	"default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/**
 * Saved and staged media. The page reads them with its bearer as blobs; a media URL opened
 * as a document of its own carries no bearer and gets the hook's 401. Should a response
 * still render as a document, the browser builds it itself and no author markup or script
 * runs there. `style-src 'unsafe-inline'` admits the inline styles of its image and video
 * documents.
 */
const mediaDocument = "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'";
/** An image document needs nothing from the origin, so it gets an opaque one. */
export const imagePolicy = `${mediaDocument}; sandbox`;
/**
 * A video document would fetch the file again, in ranges, from its own origin. Keep that
 * origin (`allow-same-origin`) so such a request meets the route's same-origin checks;
 * scripts stay disabled.
 */
export const videoPolicy = `${mediaDocument}; media-src 'self'; sandbox allow-same-origin`;

/** Saved and staged media: private to this origin, unframeable and never sniffed. */
export function mediaHeaders(kind: "image" | "video") {
	return {
		"Cache-Control": "private, no-store",
		"X-Content-Type-Options": "nosniff",
		"Cross-Origin-Resource-Policy": "same-origin",
		"Content-Security-Policy": kind === "image" ? imagePolicy : videoPolicy,
		"X-Frame-Options": "DENY",
	};
}

/** Add the baseline, keeping a page or media policy the response already set. */
export function withSecurityHeaders(response: Response) {
	for (const [name, value] of Object.entries(baseline)) response.headers.set(name, value);
	if (!response.headers.has("content-security-policy"))
		response.headers.set("content-security-policy", responsePolicy);
	return response;
}
