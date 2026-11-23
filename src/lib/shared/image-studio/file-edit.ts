import type { ImageTransform, MediaDescriptor, StageProfile } from "../media-staging/descriptor";
import { editDisclosure } from "./edit-disclosure";
import { type SeedreamProvider, seedreamProviderNames } from "./seedream";

export type StageDescriptor = MediaDescriptor<
	Extract<StageProfile, { mime: "image/png" | "image/jpeg" }>
>;

export const filePlaceholder = "https://upload-placeholder.example.org/reference";
export const fileUploadRoutes = {
	poyo: "https://api.poyo.ai/api/common/upload/stream",
	toapis: "https://toapis.com/v1/uploads/images",
};
export const fileByteLimit = { poyo: 10_000_000, toapis: 30_000_000 };
export const neutralFilename = (mime: StageDescriptor["mime"]) =>
	mime === "image/png" ? "reference.png" : "reference.jpg";

const megabytes = (size: number) => `${(size / 1_000_000).toFixed(1)} MB`;

/**
 * Explain a 413 from file Review or Queue: the provider that refused, its limit and this
 * file's size. Only a Poyo.ai refusal can be solved by choosing ToAPIs.
 */
export function fileLimitMessage(answer: unknown, fileWord: string) {
	const { provider, size, limit } = (answer ?? {}) as Record<string, unknown>;
	if (
		(provider !== "poyo" && provider !== "toapis") ||
		typeof size !== "number" ||
		typeof limit !== "number"
	)
		return "The file is too large for this provider.";
	const advice =
		provider === "poyo" ? "Choose ToAPIs or export a smaller image." : "Export a smaller image.";
	return `${seedreamProviderNames[provider]} accepts files up to ${megabytes(limit)}; this ${fileWord} is ${megabytes(size)}. ${advice}`;
}

/** Shown only with an original whose file declares a rotation (D10). */
export const originalRotationNote =
	"Providers do not document camera orientation; the result may come back rotated.";

/** The opening words of the disclosure line for a file sent unchanged. */
export const notCleanedLead = "Not cleaned.";

/** Review's disclosure for one staged file, cleaned or sent unchanged. */
export function fileDisclosure(provider: SeedreamProvider, transform: ImageTransform) {
	const name = seedreamProviderNames[provider];
	return [
		...editDisclosure(provider),
		"Queue first uploads the file, then submits one edit using the hosted URL. Anyone with that link may access the image, even after an interrupted or failed edit.",
		provider === "poyo"
			? "Poyo.ai describes temporary images as available for 72 hours. Retention of copies and task-history links is unknown."
			: "ToAPIs documents a 30-day default when automatic cleanup applies. The public link and stored copies have an unknown lifetime.",
		transform === "original"
			? `${notCleanedLead} Metadata removal is off in Settings, so Siluet sends this file to ${name} unchanged, including any location, camera, authorship or AI-source metadata.`
			: `Siluet sends only a cleaned private copy. Cleaning removed recognized EXIF, XMP, IPTC, authorship and AI-source tags and embedded Content Credentials${transform === "reencoded-rotation" ? ", and re-encoded the JPEG once at quality 95 to apply its rotation" : ""}. An embedded ICC profile stays; its creator, copyright, date, device names, descriptions and private fields can survive, as can visible watermarks.`,
		"Idle staged bytes expire after 15 minutes, and Siluet releases its copy after the transfer.",
		"The edit estimate excludes the upload. Upload price and settlement time are unknown. Starting again can create another copy and incur charges.",
	];
}
