export class AccessError extends Error {
	constructor(
		message: string,
		readonly status: 400 | 403 | 429 | 503,
	) {
		super(message);
	}
}
export const staleProof = () => new AccessError("Authorization expired. Start again.", 403);
export class RetryableFactorError extends AccessError {}
export class CandidateRetry extends AccessError {
	constructor(
		error: AccessError,
		readonly proof: string,
	) {
		super(error.message, error.status);
	}
}
export const invalidFactor = () =>
	new RetryableFactorError("Check the code and device time, or try the next unused code.", 403);
export const recoverMessage = "Stop Siluet and run bun run owner:recover to restore access.";
