import type { ProviderConnectionStatus } from "../providers/connections";
import { editDisclosure } from "./edit-disclosure";
import { parseReferenceUrl, publicReferenceUrlError, type RemoteReference } from "./references";

export const zImagePromptCharacters = 1000;
export const zImagePromptHint = `1–${zImagePromptCharacters.toLocaleString("en-US")} characters`;
export const zImageSizes = ["1:1", "4:3", "3:4", "16:9", "9:16"] as const;
type Size = (typeof zImageSizes)[number];
type Operation = "generate" | "edit";

export type ZImageDraft = {
	provider: "poyo";
	operation: Operation;
	prompt: string;
	options: { size?: Size };
	references: RemoteReference[];
};

export function createZImageDraft(operation: Operation, prompt = ""): ZImageDraft {
	return {
		provider: "poyo",
		operation,
		prompt,
		options: operation === "generate" ? { size: "1:1" } : {},
		references: [],
	};
}

export function zImageEligible(status: ProviderConnectionStatus) {
	return status.id === "poyo" && status.state === "connected";
}

const fixedDisclosure =
	"Queue sends enable_safety_checker: false to Poyo.ai. The REST API documents this setting. Whether Z-Image accepts or honors it is unverified.";

export function zImageDisclosure(operation: Operation): readonly string[] {
	return operation === "edit" ? [fixedDisclosure, ...editDisclosure("poyo")] : [fixedDisclosure];
}

type ReviewedInput = { provider: "poyo"; model: "z-image"; prompt: string } & (
	| { operation: "generate"; size: Size; references: [] }
	| { operation: "edit"; size?: Size; references: [RemoteReference] }
);

type Validation =
	| { ok: true; input: ReviewedInput }
	| {
			ok: false;
			errors: Partial<Record<"provider" | "prompt" | "size" | "references" | "draft", string>>;
	  };

function fields(value: unknown, allowed: readonly string[]): value is Record<string, unknown> {
	return (
		typeof value === "object" &&
		value !== null &&
		(Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null) &&
		Object.keys(value).every((key) => allowed.includes(key))
	);
}

// Both the browser and the POST decoders validate the same model-specific draft.
export function validateZImageDraft(value: unknown): Validation {
	if (
		!fields(value, ["provider", "operation", "prompt", "options", "references"]) ||
		(value.operation !== "generate" && value.operation !== "edit")
	)
		return { ok: false, errors: { draft: "Choose a Z-Image operation." } };
	if (value.provider !== "poyo")
		return { ok: false, errors: { provider: "Choose Poyo.ai for Z-Image." } };
	const prompt = typeof value.prompt === "string" ? value.prompt.trim() : "";
	if (!prompt || Array.from(prompt).length > zImagePromptCharacters)
		return { ok: false, errors: { prompt: `Use ${zImagePromptHint} for Z-Image.` } };
	const options = value.options;
	if (!fields(options, ["size"]))
		return { ok: false, errors: { size: "Use only a Z-Image size option." } };
	const size = zImageSizes.find((ratio) => ratio === options.size);
	if (!size && Object.hasOwn(options, "size"))
		return { ok: false, errors: { size: "Choose a supported Z-Image aspect ratio." } };
	const base = { provider: "poyo", model: "z-image", prompt } as const;
	if (value.operation === "generate") {
		if (!size) return { ok: false, errors: { size: "Choose a supported Z-Image aspect ratio." } };
		if (!Array.isArray(value.references) || value.references.length !== 0)
			return { ok: false, errors: { references: "Remove references to create an image." } };
		return { ok: true, input: { ...base, operation: "generate", size, references: [] } };
	}
	const reference: unknown =
		Array.isArray(value.references) && value.references.length === 1 ? value.references[0] : null;
	if (
		!fields(reference, ["kind", "url", "hostname"]) ||
		reference.kind !== "url" ||
		typeof reference.url !== "string" ||
		(reference.hostname !== undefined && typeof reference.hostname !== "string")
	)
		return { ok: false, errors: { references: "Provide one public image URL." } };
	const parsed = parseReferenceUrl(reference.url);
	if (!parsed) return { ok: false, errors: { references: publicReferenceUrlError } };
	return {
		ok: true,
		input: { ...base, operation: "edit", ...(size && { size }), references: [parsed] },
	};
}

export function buildZImageRequest(input: ReviewedInput) {
	return {
		method: "POST",
		url: "https://api.poyo.ai/api/generate/submit",
		body: {
			model: input.model,
			input: {
				prompt: input.prompt,
				...(input.size && { size: input.size }),
				...(input.operation === "edit" && { image_urls: [input.references[0].url] }),
				enable_safety_checker: false,
			},
		},
	} as const;
}
