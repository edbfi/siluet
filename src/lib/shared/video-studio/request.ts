import { redactPrompt } from "../image-studio/review";
import {
	poyoVideoOperations,
	releasedVideoOperations,
	resolveOperationKey,
	seedanceOperation,
} from "../media-catalog/registry";
import { poyoVideoBody, poyoVideoOptions } from "./poyo-video";
import { seedanceRequest, videoDisclosures } from "./seedance";

const requestKeys = ["draft", "operationKey", "count", "retryLimit", "acceptTerms", "token"];

function videoOperation(key: unknown) {
	const operation = resolveOperationKey(key);
	return releasedVideoOperations.find((entry) => entry === operation);
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
			disclosures: poyo.descriptor.disclosures,
		};
	}
	const seedance = seedanceRequest(d, prompt);
	return seedance
		? { ...terms, ...seedance, operation: seedanceOperation, disclosures: videoDisclosures }
		: null;
}
export type VideoRequest = NonNullable<ReturnType<typeof parseVideo>>;

export function previewVideo({ body }: Pick<VideoRequest, "body">) {
	if ("input" in body)
		return { ...body, input: { ...body.input, prompt: redactPrompt(String(body.input.prompt)) } };
	return {
		...body,
		prompt: redactPrompt(body.prompt),
		client_business_id: "[Siluet assigns a correlation ID at Queue]",
	};
}
