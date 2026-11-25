import { type AccessError, recoverMessage } from "./access-error";

/** What an access failure tells the browser: retry, or recover on the host. */
export function accessBody(error: AccessError) {
	const recoveryRequired = error.message === recoverMessage;
	return {
		message: recoveryRequired
			? recoverMessage
			: error.status === 403
				? "Security settings changed."
				: "Authenticator storage is temporarily unavailable.",
		retry: !recoveryRequired,
		recoveryRequired,
	};
}

/** The static page a document gets for an access failure. Built from fixed text and keys only. */
export function accessPage(error: AccessError, retry: string) {
	const { message, recoveryRequired } = accessBody(error);
	const text = recoveryRequired ? message : `${message} <a href="${retry}">Retry</a>`;
	return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Studio access · Siluet</title><main><h1>Studio access</h1><p>${text}</p></main></html>`;
}
