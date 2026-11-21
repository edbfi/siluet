import {
	buildSeedreamRequest,
	poyoAspectRatios,
	seedreamBackgrounds,
	seedreamOutputFormats,
	seedreamProviders,
	seedreamResolutions,
	validateSeedreamDraft,
} from "../../../shared/image-studio/seedream";

function record(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function member<T extends string>(value: unknown, choices: readonly T[]): value is T {
	return choices.some((choice) => choice === value);
}

function dimension(value: unknown): value is number | undefined {
	return value === undefined || (typeof value === "number" && Number.isSafeInteger(value));
}

export function parseQueueRequest(value: unknown) {
	if (
		!record(value) ||
		value.count !== 1 ||
		value.retryLimit !== 0 ||
		typeof value.acceptUnknown !== "boolean" ||
		Object.keys(value).some(
			(key) => !["draft", "count", "retryLimit", "acceptUnknown", "token"].includes(key),
		)
	)
		return null;
	const draft = value.draft;
	if (
		!record(draft) ||
		draft.operation !== "generate" ||
		!member(draft.provider, seedreamProviders) ||
		typeof draft.prompt !== "string" ||
		!Array.isArray(draft.references) ||
		draft.references.length !== 0
	)
		return null;
	const options = draft.options;
	if (
		!record(options) ||
		!member(options.aspectRatio, [...poyoAspectRatios, "auto"] as const) ||
		!member(options.background, seedreamBackgrounds) ||
		!member(options.resolution, seedreamResolutions) ||
		!member(options.outputFormat, seedreamOutputFormats) ||
		!member(options.sizeMode, ["tier", "pixels"] as const) ||
		typeof options.watermark !== "boolean"
	)
		return null;
	const pixels = draft.provider === "toapis" && options.sizeMode === "pixels";
	const width = pixels ? options.width : undefined;
	const height = pixels ? options.height : undefined;
	if (!dimension(width) || !dimension(height)) return null;
	const validation = validateSeedreamDraft({
		provider: draft.provider,
		operation: "generate",
		prompt: draft.prompt,
		references: [],
		options: {
			aspectRatio: options.aspectRatio,
			background: options.background,
			resolution: options.resolution,
			outputFormat: options.outputFormat,
			sizeMode: options.sizeMode,
			width,
			height,
			watermark: options.watermark,
		},
	});
	if (!validation.ok) return null;
	const input = validation.input;
	return {
		input,
		request: buildSeedreamRequest(input, () => {
			throw new Error("Generation cannot contain references.");
		}),
		acceptUnknown: value.acceptUnknown,
		token: value.token,
	};
}
export type LiveRequest = NonNullable<ReturnType<typeof parseQueueRequest>>;
