import { redactPrompt } from "../image-studio/review";
import { resolveOperationKey, seedanceOperation } from "../media-catalog/registry";
export const videoRatios = ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"] as const;
export const videoDisclosures = [
	"The prompt is sent to ToAPIs for one potentially billable submission.",
	"The total charge is unknown. Fallback may be available on eligible accounts and regions. Its route and price are unknown.",
	"Gallery accepts a limited H.264/AAC MP4 profile. A completed billable clip may be ineligible for Save.",
];
export const videoDefaults = {
	prompt: "",
	aspect_ratio: "16:9",
	duration: 5,
	resolution: "720p",
	generate_audio: true,
};
export function parseVideo(value: unknown) {
	if (
		!value ||
		typeof value !== "object" ||
		!("draft" in value) ||
		!("operationKey" in value) ||
		resolveOperationKey(value.operationKey) !== seedanceOperation ||
		!("count" in value) ||
		value.count !== 1 ||
		!("retryLimit" in value) ||
		value.retryLimit !== 0 ||
		!("acceptTerms" in value) ||
		typeof value.acceptTerms !== "boolean" ||
		Object.keys(value).some(
			(k) => !["draft", "operationKey", "count", "retryLimit", "acceptTerms", "token"].includes(k),
		)
	)
		return null;
	const d = value.draft;
	if (
		!d ||
		typeof d !== "object" ||
		Object.keys(d).some((k) => !Object.hasOwn(videoDefaults, k)) ||
		!("prompt" in d) ||
		typeof d.prompt !== "string" ||
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
	const prompt = d.prompt.trim();
	if (!ratio || !prompt || new TextEncoder().encode(prompt).length > 4000) return null;
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
	return {
		body,
		options,
		acceptTerms: value.acceptTerms,
		token: "token" in value ? value.token : null,
	};
}
export type VideoRequest = NonNullable<ReturnType<typeof parseVideo>>;
export function previewVideo(body: VideoRequest["body"]) {
	return {
		...body,
		prompt: redactPrompt(body.prompt),
		client_business_id: "[Siluet assigns a correlation ID at Queue]",
	};
}
