import type { MediaDescriptor, StageProfile } from "../media-staging/descriptor";
import { editDisclosure } from "./edit-disclosure";
import type { SeedreamProvider } from "./seedream";

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
export function fileDisclosure(provider: SeedreamProvider) {
	return [
		...editDisclosure(provider),
		"Queue first uploads the verified image, then submits one edit using the hosted URL. Anyone with that link may access the image, even after an interrupted or failed edit.",
		provider === "poyo"
			? "Poyo.ai describes temporary images as available for 72 hours. Retention of copies and task-history links is unknown."
			: "ToAPIs documents a 30-day default when automatic cleanup applies. The public link and stored copies have an unknown lifetime.",
		"Preparation removes recognized EXIF, XMP, IPTC, authorship, AI-source tags and embedded Content Credentials. It normalizes JPEG orientation. Embedded ICC creator, copyright, date, device names, descriptions and private fields can survive, as can visible watermarks. Idle staged bytes expire after 15 minutes and the uploaded copy is released locally after transfer.",
		"The edit estimate excludes the upload. Upload price and settlement time are unknown. Starting again can create another copy and incur charges.",
	];
}
