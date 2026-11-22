const failures = {
	"invalid-png": ["The PNG is incomplete or malformed.", "Export a fresh SDR PNG."],
	"unsupported-png-chunk": ["The PNG contains unsupported data.", "Export a standard SDR PNG."],
	"animated-png": ["The PNG contains animation.", "Export a single frame as an SDR PNG."],
	"hdr-png": ["The PNG declares HDR or a gain map.", "Export an SDR PNG."],
	"png-color": [
		"The PNG has unsupported color information.",
		"Export a PNG with a standard SDR profile.",
	],
	"png-orientation": [
		"The PNG orientation is ambiguous or requires a transform.",
		"Export an upright PNG with orientation applied.",
	],
	"trailing-png-data": ["The PNG contains trailing data.", "Export a fresh single-image PNG."],
	"png-limit": [
		"The PNG exceeds a preparation limit.",
		"Choose a smaller PNG with less embedded metadata.",
	],
	"png-verification": [
		"The cleaned PNG could not be verified.",
		"Export a fresh SDR PNG and try again.",
	],
	cancelled: ["PNG preparation was cancelled.", "Select the file again to retry."],
} as const;

export const pngRefusals = Object.values(failures);

export class PngCleanupError extends Error {
	readonly guidance: string;

	constructor(readonly code: keyof typeof failures) {
		super(failures[code][0]);
		this.name = "PngCleanupError";
		this.guidance = failures[code][1];
	}
}

export function assertPngActive(signal?: AbortSignal) {
	if (signal?.aborted) throw new PngCleanupError("cancelled");
}
