/**
 * Why a claim, sign-in or factor step was refused. The browser branches on it, never on the
 * message ([browser key sessions](../../../../../docs/SPEC-browser-key.md)).
 */
export type RefusalReason =
	| "invalid-signature"
	| "invalid-claim"
	| "invalid-login"
	| "stale-proof"
	| "invalid-code"
	| "session-live";
export class AccessError extends Error {
	constructor(
		message: string,
		readonly status: 400 | 403 | 409 | 429 | 503,
		readonly reason?: RefusalReason,
	) {
		super(message);
	}
}
export const staleProof = () =>
	new AccessError("Authorization expired. Start again.", 403, "stale-proof");
export class RetryableFactorError extends AccessError {}
export class CandidateRetry extends AccessError {
	constructor(
		error: AccessError,
		readonly proof: string,
	) {
		super(error.message, error.status, error.reason);
	}
}
export const invalidFactor = () =>
	new RetryableFactorError(
		"Check the code and device time, or try the next unused code.",
		403,
		"invalid-code",
	);
/** First commit wins: a key that already has a live session gets no other. */
export const sessionLive = () =>
	new AccessError("This browser is already signed in. Reload the page.", 409, "session-live");
export const recoverMessage = "Stop Siluet and run bun run owner:recover to restore access.";
