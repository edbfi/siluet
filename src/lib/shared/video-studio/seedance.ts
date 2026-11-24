import { type SeedanceOperation, seedanceOperation } from "../media-catalog/registry";
import { readFrames } from "./keyframes";
export const videoRatios = ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"] as const;
export const videoDisclosures = [
	"The prompt is sent to ToAPIs for one potentially billable submission.",
	"The total charge is unknown. Fallback may be available on eligible accounts and regions. Its route and price are unknown.",
];
export const videoDefaults = {
	prompt: "",
	aspect_ratio: "16:9",
	duration: 5,
	resolution: "720p",
	generate_audio: true,
};
const keyframeDraftKeys = ["prompt", "duration", "resolution", "generate_audio", "frames"];
// An edit's length and framing follow its source, so the draft carries neither.
const editDraftKeys = ["prompt", "resolution", "generate_audio", "frames"];

/** The reviewed Seedance body and pricing options of an exact draft, or null. */
export function seedanceRequest(operation: SeedanceOperation, d: object, prompt: string) {
	const media = operation.roles.length > 0;
	const edit = operation.mode === "edit";
	const keys = edit ? editDraftKeys : media ? keyframeDraftKeys : null;
	if (
		Object.keys(d).some((k) => (keys ? !keys.includes(k) : !Object.hasOwn(videoDefaults, k))) ||
		(!edit &&
			(!("duration" in d) ||
				typeof d.duration !== "number" ||
				!Number.isInteger(d.duration) ||
				d.duration < 4 ||
				d.duration > 10)) ||
		!("resolution" in d) ||
		(d.resolution !== "480p" && d.resolution !== "720p") ||
		!("generate_audio" in d) ||
		typeof d.generate_audio !== "boolean"
	)
		return null;
	// ToAPIs requires adaptive framing for edits and first/last-frame tasks; the media sets it.
	const ratio = media
		? "adaptive"
		: "aspect_ratio" in d && videoRatios.find((r) => r === d.aspect_ratio);
	const parsed = media ? readFrames(operation.roles, "frames" in d && d.frames) : null;
	if (!ratio || (parsed && "error" in parsed)) return null;
	const frames = parsed?.frames ?? [];
	const options = {
		video_operation: edit ? "edit" : "generate",
		// ToAPIs accepts only -1 for an edit: its length matches the source.
		duration: edit ? -1 : Number("duration" in d && d.duration),
		aspect_ratio: ratio,
		resolution: d.resolution,
		generate_audio: d.generate_audio,
		output_format: "mp4",
		return_last_frame: false,
		disable_nsfw: false,
	} as const;
	const model = seedanceOperation.key.model;
	const roles = frames.map(({ url, role }) => ({ url, role }));
	// Media stays out of pricing options; text-to-video bytes are unchanged.
	const body = edit
		? { model, prompt, ...options, video_with_roles: roles }
		: media
			? { model, prompt, ...options, image_with_roles: roles }
			: { model, prompt, ...options };
	return { body, options, frames };
}
export type SeedanceBody = NonNullable<ReturnType<typeof seedanceRequest>>["body"];
