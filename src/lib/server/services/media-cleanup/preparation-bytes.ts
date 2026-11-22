import { localImageLimitRefusal, maxLocalImageBytes } from "../../../shared/media-staging/limits";

// Both qualified cleaners impose a lower encoded limit than the 32,000,000-byte transport.
export const maxPreparationBytes = maxLocalImageBytes;
export const maxRefusalBytes = 512;

export function mediaMime(bytes: Uint8Array) {
	if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
	if ([137, 80, 78, 71, 13, 10, 26, 10].every((byte, i) => bytes[i] === byte)) return "image/png";
}

const failures = {
	format: ["Unsupported image format.", "Choose a single-frame SDR JPEG or PNG."],
	limit: localImageLimitRefusal,
	busy: ["Another file is being prepared.", "Retry after the current preparation finishes."],
	cancelled: ["Image preparation was cancelled.", "Select the file again to retry."],
	timeout: ["Image preparation timed out.", "Choose a smaller SDR JPEG or PNG and try again."],
	failed: ["The image could not be prepared.", "Export a fresh SDR JPEG or PNG and try again."],
} as const;

export const preparationRefusals = Object.values(failures);

export class PreparationError extends Error {
	readonly advice: string;
	constructor(
		readonly code: keyof typeof failures | "declined",
		[reason, advice]: readonly [string, string],
	) {
		super(reason);
		this.name = "PreparationError";
		this.advice = advice;
	}
}

export function failure(code: keyof typeof failures) {
	return new PreparationError(code, failures[code]);
}
