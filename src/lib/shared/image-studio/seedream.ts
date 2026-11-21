import {
	maxSeedreamReferences,
	parseReferenceUrl,
	publicReferenceUrlError,
	referenceFileError,
	type SeedreamReference,
} from "./references";

export const seedreamProviders = ["poyo", "toapis"] as const;
export type SeedreamProvider = (typeof seedreamProviders)[number];
export type SeedreamOperation = "generate" | "edit";

export const seedreamProviderNames = { poyo: "Poyo.ai", toapis: "ToAPIs" } as const;
export const seedreamOperations = {
	generate: "Create image",
	edit: "Edit image",
} as const;

export const poyoAspectRatios = [
	"1:1",
	"4:3",
	"3:4",
	"16:9",
	"9:16",
	"3:2",
	"2:3",
	"21:9",
] as const;
export const seedreamResolutions = ["1K", "1.5K", "2K"] as const;
export const seedreamBackgrounds = ["auto", "opaque", "transparent"] as const;
export const seedreamOutputFormats = ["png", "jpeg"] as const;
export const toapisPixelLimits = { minArea: 921_600, maxArea: 4_624_220, maxRatio: 16 } as const;
export const poyoPromptLimits = { min: 5, max: 5000 } as const;

type AspectRatio = (typeof poyoAspectRatios)[number] | "auto";
type Resolution = (typeof seedreamResolutions)[number];
type Background = (typeof seedreamBackgrounds)[number];
type OutputFormat = (typeof seedreamOutputFormats)[number];
type PixelSize = `${number}x${number}`;

export type SeedreamDraft = {
	provider: SeedreamProvider | null;
	operation: SeedreamOperation;
	prompt: string;
	references: SeedreamReference[];
	options: {
		aspectRatio: AspectRatio;
		resolution: Resolution;
		sizeMode: "tier" | "pixels";
		width: number | undefined;
		height: number | undefined;
		background: Background;
		outputFormat: OutputFormat;
		watermark: boolean;
	};
};

type CommonReviewInput = {
	operation: SeedreamOperation;
	prompt: string;
	references: readonly SeedreamReference[];
	background: Background;
	outputFormat: OutputFormat;
};

export type SeedreamReviewInput = CommonReviewInput &
	(
		| { provider: "poyo"; model: "seedream-5.5"; aspectRatio: AspectRatio; resolution: Resolution }
		| {
				provider: "toapis";
				model: "doubao-seedream-5-5";
				size: Resolution | PixelSize;
				watermark: boolean;
		  }
	);

type DraftErrors = Partial<
	Record<"provider" | "prompt" | "size" | "outputFormat" | "references", string>
>;
type DraftValidation =
	| { ok: true; input: SeedreamReviewInput }
	| { ok: false; errors: DraftErrors };

export function createSeedreamDraft(
	provider: SeedreamProvider | null = null,
	operation: SeedreamOperation = "generate",
): SeedreamDraft {
	return {
		provider,
		operation,
		prompt: "",
		references: [],
		options: {
			aspectRatio: operation === "edit" ? "auto" : "1:1",
			resolution: "2K",
			sizeMode: "tier",
			width: 2048,
			height: 2048,
			background: "auto",
			outputFormat: "png",
			watermark: false,
		},
	};
}

export function switchSeedreamDraft(
	draft: SeedreamDraft,
	provider: SeedreamProvider | null,
	operation: SeedreamOperation = draft.operation,
): SeedreamDraft {
	if (draft.provider === provider && draft.operation === operation) return draft;
	return { ...createSeedreamDraft(provider, operation), prompt: draft.prompt };
}

function pixelSize(width: number | undefined, height: number | undefined): PixelSize | null {
	if (
		width === undefined ||
		height === undefined ||
		!Number.isSafeInteger(width) ||
		!Number.isSafeInteger(height) ||
		width <= 0 ||
		height <= 0
	) {
		return null;
	}
	const { minArea, maxArea, maxRatio } = toapisPixelLimits;
	const area = width * height;
	return area >= minArea &&
		area <= maxArea &&
		Math.max(width, height) <= maxRatio * Math.min(width, height)
		? `${width}x${height}`
		: null;
}

export function validateSeedreamDraft(
	draft: SeedreamDraft,
	eligibleProviders: readonly SeedreamProvider[] = seedreamProviders,
): DraftValidation {
	const { provider, operation, options } = draft;
	if (!provider || !eligibleProviders.includes(provider)) {
		return { ok: false, errors: { provider: "Connect an eligible provider in Settings." } };
	}

	const errors: DraftErrors = {};
	const prompt = draft.prompt.trim();
	const { min, max } = poyoPromptLimits;
	if (!prompt) {
		errors.prompt = "Enter a prompt.";
	} else if (provider === "poyo") {
		const characters = Array.from(prompt).length;
		if (characters < min || characters > max) {
			errors.prompt = `Use ${min}–${max.toLocaleString("en-US")} characters for Poyo.ai.`;
		}
	}

	const references: SeedreamReference[] = [];
	if (operation === "edit") {
		if (draft.references.length < 1 || draft.references.length > maxSeedreamReferences) {
			errors.references = `Add 1–${maxSeedreamReferences} reference images.`;
		} else {
			for (const [index, reference] of draft.references.entries()) {
				const parsed = reference.kind === "url" ? parseReferenceUrl(reference.url) : reference;
				const error = parsed?.kind === "file" ? referenceFileError(provider, parsed.file) : null;
				if (!parsed || error) {
					errors.references = `Reference image ${index + 1}. ${error ?? publicReferenceUrlError}`;
					break;
				}
				references.push(parsed.kind === "file" ? { ...parsed } : parsed);
			}
		}
	}

	const { aspectRatio, resolution, background, outputFormat, watermark } = options;
	if (background === "transparent" && outputFormat !== "png") {
		errors.outputFormat = "Choose PNG for a transparent background.";
	}
	if (provider === "poyo" && operation === "generate" && aspectRatio === "auto") {
		errors.size = "Choose a fixed aspect ratio for a new image.";
	}

	const exactSize = provider === "toapis" && options.sizeMode === "pixels";
	const size = exactSize ? pixelSize(options.width, options.height) : resolution;
	if (!size) {
		errors.size =
			"Use whole dimensions totaling 921,600–4,624,220 pixels with a ratio from 1:16 to 16:1.";
	}
	if (!size || Object.keys(errors).length) return { ok: false, errors };

	const input = { operation, prompt, references, background, outputFormat };
	return provider === "poyo"
		? { ok: true, input: { ...input, provider, model: "seedream-5.5", aspectRatio, resolution } }
		: { ok: true, input: { ...input, provider, model: "doubao-seedream-5-5", size, watermark } };
}

export function buildSeedreamRequest(
	input: SeedreamReviewInput,
	referenceUrl: (reference: SeedreamReference, index: number) => string,
) {
	const { model, prompt, background, outputFormat } = input;
	const output = { background, output_format: outputFormat };
	const references =
		input.operation === "edit" ? { image_urls: input.references.map(referenceUrl) } : {};

	if (input.provider === "poyo") {
		return {
			method: "POST",
			url: "https://api.poyo.ai/api/generate/submit",
			body: {
				model,
				input: {
					prompt,
					size: input.aspectRatio,
					resolution: input.resolution,
					...output,
					enable_safety_checker: false,
					...references,
				},
			},
		} as const;
	}

	return {
		method: "POST",
		url: "https://toapis.com/v1/images/generations",
		body: {
			model,
			prompt,
			size: input.size,
			disable_nsfw: false,
			metadata: { ...output, watermark: input.watermark },
			...references,
		},
	} as const;
}
