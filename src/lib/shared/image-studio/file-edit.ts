import type { ImageTransform, MediaDescriptor, StageProfile } from "../media-staging/descriptor";
import { editDisclosure } from "./edit-disclosure";
import { type SeedreamProvider, seedreamProviderNames } from "./seedream-options";

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
 * Explain a 413 from file Review or Queue: the provider that refused, its limit, the
 * refused slot's position and its file's size. Only a Poyo.ai refusal can be solved by choosing ToAPIs.
 */
export function fileLimitMessage(answer: unknown, fileWord: string) {
	const { provider, size, limit, position } = (answer ?? {}) as Record<string, unknown>;
	if (
		(provider !== "poyo" && provider !== "toapis") ||
		typeof size !== "number" ||
		typeof limit !== "number"
	)
		return "The file is too large for this provider.";
	const advice =
		provider === "poyo" ? "Choose ToAPIs or export a smaller image." : "Export a smaller image.";
	const refused = Number.isSafeInteger(position)
		? `the ${fileWord} in reference ${position}`
		: `this ${fileWord}`;
	return `${seedreamProviderNames[provider]} accepts files up to ${megabytes(limit)}; ${refused} is ${megabytes(size)}. ${advice}`;
}

/** Shown only with an original whose file declares a rotation (D10). */
export const originalRotationNote =
	"Providers do not document camera orientation; the result may come back rotated.";

/** The opening words of the disclosure line for a file sent unchanged. */
export const notCleanedLead = "Not cleaned.";

/** One staged file slot as Review discloses it: its 1-based reference position and preparation. */
export type DisclosedFile = { position: number; transform: ImageTransform; rotated: boolean };

const listed = (positions: readonly number[]) =>
	positions.length === 1
		? `reference ${positions[0]}`
		: `references ${positions.slice(0, -1).join(", ")} and ${positions.at(-1)}`;

/**
 * Review's disclosure for the staged files of one edit, in reference order: each slot's
 * preparation (cleaned, re-encoded for rotation, or sent unchanged), the uploads before the
 * edit and, on Poyo.ai, the account's shared upload window. One file keeps its own words.
 */
export function fileDisclosure(provider: SeedreamProvider, files: readonly DisclosedFile[]) {
	const name = seedreamProviderNames[provider];
	const one = files.length === 1;
	const original = files.filter((file) => file.transform === "original");
	const reencoded = files.filter((file) => file.transform === "reencoded-rotation");
	const rotated = original.filter((file) => file.rotated).map((file) => file.position);
	const positions = (selected: readonly DisclosedFile[]) => selected.map((file) => file.position);
	return [
		...editDisclosure(provider),
		one
			? "Queue first uploads the file, then submits one edit using the hosted URL. Anyone with that link may access the image, even after an interrupted or failed edit."
			: `Queue first uploads ${files.length} files one at a time in reference order, then submits one edit using the hosted URLs: up to ${files.length + 1} potentially billable requests. Anyone with an upload link may access that image, even after an interrupted or failed edit.`,
		provider === "poyo"
			? "Poyo.ai describes temporary images as available for 72 hours. Retention of copies and task-history links is unknown."
			: "ToAPIs documents a 30-day default when automatic cleanup applies. The public link and stored copies have an unknown lifetime.",
		...(provider === "poyo" && !one
			? [
					"Poyo.ai allows ten uploads per account in any 60 seconds, shared by every key and signed-in session. Other activity on the account can throttle a later file and leave earlier copies hosted.",
				]
			: []),
		...(original.length
			? [
					`${notCleanedLead} Metadata removal is off in Settings, so Siluet sends ${one ? "this file" : listed(positions(original))} to ${name} unchanged, including any location, camera, authorship or AI-source metadata.`,
				]
			: []),
		...(original.length < files.length
			? [
					`Siluet sends only ${one ? "a cleaned private copy" : "cleaned private copies"}. Cleaning removed recognized EXIF, XMP, IPTC, authorship and AI-source tags and embedded Content Credentials${reencoded.length ? `, and re-encoded the JPEG${one ? "" : ` of ${listed(positions(reencoded))}`} once at quality 95 to apply its rotation` : ""}. An embedded ICC profile stays; its creator, copyright, date, device names, descriptions and private fields can survive, as can visible watermarks.`,
				]
			: []),
		...(rotated.length
			? [one ? originalRotationNote : `${originalRotationNote} This applies to ${listed(rotated)}.`]
			: []),
		one
			? "Idle staged bytes expire after 15 minutes, and Siluet releases its copy after the transfer."
			: "Idle staged bytes expire after 15 minutes, and Siluet releases each copy once it is read for upload.",
		`The edit estimate excludes the ${one ? "upload" : "uploads"}. Upload price and settlement time are unknown. Starting again can create ${one ? "another copy" : "other copies"} and incur charges.`,
	];
}
