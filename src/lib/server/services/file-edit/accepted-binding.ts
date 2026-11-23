import type { FileRequest } from "./request";

/** The durable binding of an accepted file Review, matched by an identical replay. */
export function acceptedFileBinding(
	mac: (...parts: unknown[]) => string,
	owner: string,
	token: string,
	live: FileRequest,
) {
	const { draft, handle, digest, mime, transform, size, deadline } = live.stage;
	return mac(
		"file-accepted-owner-v2",
		owner,
		token,
		{ draft, handle, digest, mime, transform, size, deadline },
		live.draft,
		live.request,
		1,
		0,
		live.acceptUnknown,
	);
}
