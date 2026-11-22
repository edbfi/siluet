import { seedanceOperation } from "../media-catalog/registry";
import { saveProfileDisclosure } from "./save-profile";
export const videoRatios = ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"] as const;
export const videoDisclosures = [
	"The prompt is sent to ToAPIs for one potentially billable submission.",
	"The total charge is unknown. Fallback may be available on eligible accounts and regions. Its route and price are unknown.",
	saveProfileDisclosure,
];
export const videoDefaults = {
	prompt: "",
	aspect_ratio: "16:9",
	duration: 5,
	resolution: "720p",
	generate_audio: true,
};
/** The reviewed Seedance options of an exact draft, or null. */
export function seedanceRequest(d: object, prompt: string) {
	if (
		Object.keys(d).some((k) => !Object.hasOwn(videoDefaults, k)) ||
		!("duration" in d) ||
		typeof d.duration !== "number" ||
		!Number.isInteger(d.duration) ||
		d.duration < 4 ||
		d.duration > 10 ||
		!("resolution" in d) ||
		(d.resolution !== "480p" && d.resolution !== "720p") ||
		!("generate_audio" in d) ||
		typeof d.generate_audio !== "boolean" ||
		!("aspect_ratio" in d)
	)
		return null;
	const ratio = videoRatios.find((r) => r === d.aspect_ratio);
	if (!ratio) return null;
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
	const body = { model: seedanceOperation.key.model, prompt, ...options };
	return { body, options };
}
export type SeedanceBody = NonNullable<ReturnType<typeof seedanceRequest>>["body"];
