import { redactPrompt } from "../image-studio/review";
import {
	type PoyoVideoOperation,
	poyoVideoOperations,
	releasedVideoOperations,
	resolveOperationKey,
	type SeedanceOperation,
	seedanceOperations,
} from "../media-catalog/registry";
import { type Frame, frameReviewLabels, keyframeDisclosures } from "./keyframes";
import { poyoVideoBody, poyoVideoOptions } from "./poyo-video";
import { saveDisclosure } from "./save-profile";
import { seedanceRequest, videoDisclosures } from "./seedance";

const requestKeys = ["draft", "operationKey", "count", "retryLimit", "acceptTerms", "token"];

function videoOperation(key: unknown) {
	const operation = resolveOperationKey(key);
	return releasedVideoOperations.find((entry) => entry === operation);
}

/** Review's disclosures for one operation: its own, then its Save limit, if it has one. */
export function videoReviewDisclosures(operation: SeedanceOperation | PoyoVideoOperation) {
	const own =
		"descriptor" in operation
			? operation.descriptor.disclosures
			: operation.roles.length
				? keyframeDisclosures
				: videoDisclosures;
	const save = saveDisclosure(operation);
	return save ? [...own, save] : [...own];
}

/** One reviewed video request, dispatched by its exact registry operation's provider. */
export function parseVideo(value: unknown) {
	if (
		!value ||
		typeof value !== "object" ||
		!("draft" in value) ||
		!("operationKey" in value) ||
		!("count" in value) ||
		value.count !== 1 ||
		!("retryLimit" in value) ||
		value.retryLimit !== 0 ||
		!("acceptTerms" in value) ||
		typeof value.acceptTerms !== "boolean" ||
		Object.keys(value).some((k) => !requestKeys.includes(k))
	)
		return null;
	const operation = videoOperation(value.operationKey);
	const d = value.draft;
	if (!operation || !d || typeof d !== "object" || !("prompt" in d) || typeof d.prompt !== "string")
		return null;
	const prompt = d.prompt.trim();
	if (!prompt || new TextEncoder().encode(prompt).length > 4000) return null;
	const terms = { acceptTerms: value.acceptTerms, token: "token" in value ? value.token : null };
	if (operation.key.provider === "poyo") {
		const poyo = poyoVideoOperations.find((entry) => entry === operation);
		const options = poyo && poyoVideoOptions(poyo.descriptor, d);
		if (!poyo || !options) return null;
		return {
			...terms,
			operation: poyo,
			body: poyoVideoBody(poyo.descriptor, prompt, options),
			options,
			frames: [] as Frame[],
			disclosures: videoReviewDisclosures(poyo),
		};
	}
	const seedance = seedanceOperations.find((entry) => entry === operation);
	const request = seedance && seedanceRequest(seedance, d, prompt);
	if (!seedance || !request) return null;
	return {
		...terms,
		...request,
		operation: seedance,
		disclosures: videoReviewDisclosures(seedance),
	};
}
export type VideoRequest = NonNullable<ReturnType<typeof parseVideo>>;

/** The outgoing request with the prompt redacted and each frame URL replaced by its label. */
export function previewVideo({ body, frames }: Pick<VideoRequest, "body" | "frames">) {
	if ("input" in body)
		return { ...body, input: { ...body.input, prompt: redactPrompt(String(body.input.prompt)) } };
	const labels = frameReviewLabels(frames);
	return {
		...body,
		prompt: redactPrompt(body.prompt),
		...("image_with_roles" in body && {
			image_with_roles: body.image_with_roles.map(({ role }, i) => ({ url: labels[i], role })),
		}),
		client_business_id: "[Siluet assigns a correlation ID at Queue]",
	};
}
