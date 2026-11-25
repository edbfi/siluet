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

/** The reviewed Seedance body and pricing options of an exact draft, or null. */
export function seedanceRequest(operation: SeedanceOperation, d: object, prompt: string) {
	const keyframes = operation.roles.length > 0;
	if (
		Object.keys(d).some((k) =>
			keyframes ? !keyframeDraftKeys.includes(k) : !Object.hasOwn(videoDefaults, k),
		) ||
		!("duration" in d) ||
		typeof d.duration !== "number" ||
		!Number.isInteger(d.duration) ||
		d.duration < 4 ||
		d.duration > 10 ||
		!("resolution" in d) ||
		(d.resolution !== "480p" && d.resolution !== "720p") ||
		!("generate_audio" in d) ||
		typeof d.generate_audio !== "boolean"
	)
		return null;
	// ToAPIs requires adaptive framing for first/last-frame tasks; the starting frame sets it.
	const ratio = keyframes
		? "adaptive"
		: "aspect_ratio" in d && videoRatios.find((r) => r === d.aspect_ratio);
	const parsed = keyframes ? readFrames(operation.roles, "frames" in d && d.frames) : null;
	if (!ratio || (parsed && "error" in parsed)) return null;
	const frames = parsed?.frames ?? [];
	const options = {
		video_operation: "generate",
		duration: d.duration,
		aspect_ratio: ratio,
		resolution: d.resolution,
		generate_audio: d.generate_audio,
		output_format: "mp4",
		return_last_frame: false,
		disable_nsfw: false,
	} as const;
	const model = seedanceOperation.key.model;
	// Frames stay out of pricing options; text-to-video bytes are unchanged.
	const body = keyframes
		? {
				model,
				prompt,
				...options,
				image_with_roles: frames.map(({ url, role }) => ({ url, role })),
			}
		: { model, prompt, ...options };
	return { body, options, frames };
}
export type SeedanceBody = NonNullable<ReturnType<typeof seedanceRequest>>["body"];
