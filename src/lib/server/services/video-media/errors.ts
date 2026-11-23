/** Why a complete video file stays out of Gallery. */
export type UnsupportedVideoReason = "profile" | "webm";

/** A complete file outside Gallery's MP4 profile. Retrying the same download cannot change it. */
export class UnsupportedVideoError extends Error {
	constructor(
		readonly detail: string,
		readonly reason: UnsupportedVideoReason = "profile",
	) {
		super(`Unsupported video: ${detail}.`);
		this.name = "UnsupportedVideoError";
	}
}

/** The file ends inside a box, so the download is incomplete rather than unsupported. */
export class TruncatedVideoError extends Error {
	constructor() {
		super("The video file ends inside a box.");
		this.name = "TruncatedVideoError";
	}
}

export function check(condition: unknown, detail: string): asserts condition {
	if (!condition) throw new UnsupportedVideoError(detail);
}
