import {
	duplicateReferenceSlots,
	maxSeedreamReferences,
	parseReferenceUrl,
	type RemoteReference,
} from "../../../shared/image-studio/references";
import {
	buildSeedreamRequest,
	poyoAspectRatios,
	seedreamBackgrounds,
	seedreamOutputFormats,
	seedreamResolutions,
	validateSeedreamDraft,
} from "../../../shared/image-studio/seedream";
import { releasedProviders, resolveOperationKey } from "../../../shared/media-catalog/registry";

function record(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function member<T extends string>(value: unknown, choices: readonly T[]): value is T {
	return choices.some((choice) => choice === value);
}

function dimension(value: unknown): value is number | undefined {
	return value === undefined || (typeof value === "number" && Number.isSafeInteger(value));
}

const draftFields = ["operation", "provider", "prompt", "references", "options"];
const optionFields = [
	"aspectRatio",
	"background",
	"resolution",
	"outputFormat",
	"sizeMode",
	"width",
	"height",
	"watermark",
];

export function parseQueueRequest(value: unknown) {
	if (
		!record(value) ||
		value.count !== 1 ||
		value.retryLimit !== 0 ||
		typeof value.acceptUnknown !== "boolean" ||
		Object.keys(value).some(
			(key) =>
				!["draft", "operationKey", "count", "retryLimit", "acceptUnknown", "token"].includes(key),
		)
	)
		return null;
	const draft = value.draft;
	if (
		!record(draft) ||
		(draft.operation !== "generate" && draft.operation !== "edit") ||
		!member(draft.provider, releasedProviders) ||
		typeof draft.prompt !== "string" ||
		Object.keys(draft).some((key) => !draftFields.includes(key)) ||
		!Array.isArray(draft.references)
	)
		return null;
	const options = draft.options;
	if (
		!record(options) ||
		Object.keys(options).some((key) => !optionFields.includes(key)) ||
		!member(options.aspectRatio, [...poyoAspectRatios, "auto"] as const) ||
		!member(options.background, seedreamBackgrounds) ||
		!member(options.resolution, seedreamResolutions) ||
		!member(options.outputFormat, seedreamOutputFormats) ||
		!member(options.sizeMode, ["tier", "pixels"] as const) ||
		typeof options.watermark !== "boolean"
	)
		return null;
	const references: RemoteReference[] = [];
	if (draft.operation === "edit") {
		if (draft.references.length < 1 || draft.references.length > maxSeedreamReferences) return null;
		for (const reference of draft.references as unknown[]) {
			if (
				!record(reference) ||
				reference.kind !== "url" ||
				typeof reference.url !== "string" ||
				(reference.hostname !== undefined && typeof reference.hostname !== "string") ||
				Object.keys(reference).some((key) => !["kind", "url", "hostname"].includes(key))
			)
				return null;
			const parsed = parseReferenceUrl(reference.url);
			if (!parsed) return null;
			references.push(parsed);
		}
		if (duplicateReferenceSlots(references)) return null;
	} else if (draft.references.length !== 0) {
		return null;
	}
	const pixels = draft.provider === "toapis" && options.sizeMode === "pixels";
	const width = pixels ? options.width : undefined;
	const height = pixels ? options.height : undefined;
	if (!dimension(width) || !dimension(height)) return null;
	const validation = validateSeedreamDraft({
		provider: draft.provider,
		operation: draft.operation,
		prompt: draft.prompt,
		references,
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
	const { entry, input } = validation;
	// Older Reviews carry only the Seedream provider and draft mode.
	if ("operationKey" in value && resolveOperationKey(value.operationKey) !== entry) return null;
	return {
		entry,
		input,
		request: buildSeedreamRequest(input, (reference) => {
			if (reference.kind !== "url") throw new Error("Live edits require a URL reference.");
			return reference.url;
		}),
		acceptUnknown: value.acceptUnknown,
		token: value.token,
	};
}
export type LiveRequest = NonNullable<ReturnType<typeof parseQueueRequest>>;
