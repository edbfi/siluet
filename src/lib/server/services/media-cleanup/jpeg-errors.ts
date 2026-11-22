const exportAdvice = "Export a single-frame SDR JPEG or PNG.";
const messages = {
	invalid: ["The JPEG is damaged or incomplete.", exportAdvice],
	limit: ["The JPEG exceeds local preparation limits.", "Choose a smaller SDR JPEG or PNG."],
	unsupported: ["The JPEG uses unsupported image coding.", exportAdvice],
	metadata: ["The JPEG contains unclassified or unreadable metadata.", exportAdvice],
	orientation: [
		"The JPEG has ambiguous or invalid orientation.",
		"Export an upright SDR JPEG or PNG.",
	],
	color: [
		"The JPEG color declaration cannot be preserved safely.",
		"Export an SDR JPEG or PNG with an embedded ICC profile.",
	],
	aspect: [
		"The JPEG pixel aspect ratio cannot be preserved safely.",
		"Export a square-pixel SDR JPEG or PNG.",
	],
	hdr: ["The JPEG declares HDR or a gain map.", exportAdvice],
	motion: ["The JPEG is a motion photo.", "Export the still image as an SDR JPEG or PNG."],
	secondary: ["The JPEG contains a secondary image.", exportAdvice],
	trailer: ["The JPEG contains data after the image.", exportAdvice],
	verification: ["The prepared JPEG failed verification.", exportAdvice],
	cancelled: ["JPEG preparation was cancelled.", "Select the file again to retry."],
} as const;

export const jpegRefusals = Object.values(messages);

export class JpegCleanupError extends Error {
	readonly advice: string;

	constructor(readonly code: keyof typeof messages) {
		const [reason, advice] = messages[code];
		super(reason);
		this.name = "JpegCleanupError";
		this.advice = advice;
	}
}

export function refuseJpeg(code: JpegCleanupError["code"]): never {
	throw new JpegCleanupError(code);
}
