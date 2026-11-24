import { parseReferenceUrl } from "../image-studio/references";

// https://docs.toapis.com/docs/en/api-reference/videos/seedance-2-5/generation (2026-11-24):
// image_with_roles takes first_frame and last_frame, video_with_roles takes reference_video;
// a URL over 2,048 bytes is refused.
export const frameLabels = {
	first_frame: "Starting frame",
	last_frame: "Ending frame",
	reference_video: "Source clip",
} as const;
export type FrameRole = keyof typeof frameLabels;
/** The kind of media a role sends, as the estimator classifies it. */
export const roleMedia = (role: FrameRole) => (role === "reference_video" ? "video" : "image");
export type Frame = { role: FrameRole; url: string; hostname: string };
const maxFrameUrlBytes = 2048;

export const keyframeDisclosures = [
	"Queue sends your prompt and each complete frame URL, including signed queries, to ToAPIs and possibly its upstream processors. Their access, retention and fetch timing are unknown. Signed links can expire while fetched copies persist. Use a new URL when an image changes.",
	"Asset review can keep the task queued for up to 20 minutes per round by default. After the ten-minute automatic tracking ends, use Refresh status in Jobs. ToAPIs documents no video generation fee for a failed asset review; Jobs shows a refund only when billing confirms it.",
	"Use still images within ToAPIs' 30 MB limit. Upstream, BytePlus lists JPEG, PNG, WebP, BMP, TIFF, GIF, HEIC and HEIF, 300–6,000 px per edge, a width-to-height ratio of 0.4–2.5, and refuses direct images that contain real human faces. Whether this route enforces those limits is unverified; Siluet does not check them.",
	"Actual usage and account charges are unknown. Eligible accounts or regions may use fallback with unknown availability and price.",
];

export const keyframeAcceptance =
	"I accept the unknown charge, sending the complete frame URLs to ToAPIs and its processors under their access and retention terms, and Gallery Save limitations.";

/** Why one frame URL cannot be sent, or null. Nothing is fetched. */
export function frameUrlProblem(role: FrameRole, value: string): string | null {
	const label = frameLabels[role];
	if (!value.trim()) return `Enter a public URL for the ${label.toLowerCase()}.`;
	const reference = parseReferenceUrl(value);
	if (!reference) return `${label} requires a public HTTP or HTTPS URL without credentials.`;
	if (new TextEncoder().encode(reference.url).length > maxFrameUrlBytes)
		return `${label} exceeds 2,048 UTF-8 bytes.`;
	return null;
}

export const duplicateFrames =
	"Starting frame and Ending frame use the same URL. Choose two distinct frames.";

/** The exact frames of an operation's roles, in order, each `{ role, url }`. */
export function readFrames(
	roles: readonly FrameRole[],
	slots: unknown,
): { frames: Frame[] } | { error: string } {
	if (!Array.isArray(slots) || slots.length !== roles.length)
		return { error: "Supply exactly the frames this operation requires." };
	const frames: Frame[] = [];
	for (const [index, role] of roles.entries()) {
		const slot: unknown = slots[index];
		if (
			!slot ||
			typeof slot !== "object" ||
			Object.keys(slot).length !== 2 ||
			!("role" in slot) ||
			slot.role !== role ||
			!("url" in slot) ||
			typeof slot.url !== "string"
		)
			return { error: `Enter a public URL for the ${frameLabels[role].toLowerCase()}.` };
		const problem = frameUrlProblem(role, slot.url);
		const reference = parseReferenceUrl(slot.url);
		if (problem || !reference) return { error: problem ?? "Invalid frame URL." };
		if (frames.some((frame) => frame.url === reference.url)) return { error: duplicateFrames };
		frames.push({ role, url: reference.url, hostname: reference.hostname });
	}
	return { frames };
}

/** Review names each frame by role and host; the complete URL never returns. */
export function frameReviewLabels(frames: readonly Frame[]) {
	return frames.map(({ role, hostname }) => `${frameLabels[role]} · ${hostname}`);
}
