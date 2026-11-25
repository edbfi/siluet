import type { ProviderId } from "../providers/connections";
import { h3Max } from "../video-studio/h3-max";
import type { PoyoVideoDescriptor } from "../video-studio/poyo-video";
import type { SaveLimit } from "../video-studio/save-profile";

// The browser needs only released operations. The ledger test reconciles these
// exact keys against the dated inventory and its explicit family aliases.
export const seedreamModel = {
	id: "seedream-5.5",
	label: "Seedream 5.5",
	family: "ByteDance / Seedream",
} as const;

export const zImageModel = {
	id: "z-image",
	label: "Z-Image",
	family: "Alibaba / Z-Image",
} as const;
export const releasedImageModels = [seedreamModel, zImageModel] as const;
const seedanceModel = {
	id: "seedance-2.5",
	label: "Seedance 2.5",
	family: "ByteDance / Seedance",
} as const;
const h3MaxModel = { id: h3Max.model, label: h3Max.label, family: h3Max.family } as const;
export const releasedModels = [...releasedImageModels, seedanceModel, h3MaxModel] as const;

export const seedreamRoutes = {
	poyo: {
		model: "seedream-5.5",
		origin: "https://api.poyo.ai",
		path: "/api/generate/submit",
	},
	toapis: {
		model: "doubao-seedream-5-5",
		origin: "https://toapis.com",
		path: "/v1/images/generations",
	},
} as const;

const ordinaryOperations = {
	"text-to-image": { mode: "generate", label: "Create image" },
	"reference-image-edit": { mode: "edit", label: "Edit image" },
} as const;

type FieldEvidence = "declared" | "unknown" | "conflict";
type FilteringEvidence = { d4: FieldEvidence; catalogD4: FieldEvidence };

// Both ordinary Seedream contracts declare the fixed flag. An absent catalog
// observation is unknown; a contradictory observation blocks a new claim.
const seedreamEvidence: FilteringEvidence = { d4: "declared", catalogD4: "unknown" };

export function queueEvidenceProblem({ d4, catalogD4 }: FilteringEvidence) {
	if (d4 === "conflict" || catalogD4 === "conflict")
		return "Queue is unavailable because the filtering flag conflicts with the provider contract.";
	if (d4 !== "declared")
		return "Queue requires confirmation that the provider accepts the filtering flag.";
	return null;
}

function seedreamEntry(provider: ProviderId, operation: keyof typeof ordinaryOperations) {
	const { model, path } = seedreamRoutes[provider];
	return {
		modelId: seedreamModel.id,
		profile: `seedream-${ordinaryOperations[operation].mode}`,
		key: { provider, model, route: `POST ${path}`, operation },
		...ordinaryOperations[operation],
		evidence: seedreamEvidence,
	};
}

const zImageEvidence: FilteringEvidence = { d4: "declared", catalogD4: "unknown" };

function zImageEntry(operation: keyof typeof ordinaryOperations) {
	return {
		modelId: zImageModel.id,
		profile: `z-image-${ordinaryOperations[operation].mode}`,
		key: { provider: "poyo", model: zImageModel.id, route: "POST /api/generate/submit", operation },
		...ordinaryOperations[operation],
		evidence: zImageEvidence,
	} as const;
}

// https://docs.toapis.com/docs/en/api-reference/videos/seedance-2-5/generation (2026-11-24):
// "The official range is `4`–`30`; use `-1` to let the model choose the duration."
// Typed as a limit or none, so a catalog row or test copy may carry either.
const seedanceSave = { seconds: 30, basis: "provider" } as SaveLimit | null;

export const seedanceOperation = {
	modelId: seedanceModel.id,
	profile: "seedance-generate",
	key: {
		provider: "toapis",
		model: "seedance-2-5",
		route: "POST /v1/videos/generations",
		operation: "text-to-video",
	},
	mode: "generate",
	label: "Create video",
	evidence: { d4: "declared", catalogD4: "unknown" },
	roles: [],
	save: seedanceSave,
} as const;

// Public-URL media operations on the same ToAPIs route. Frames go in image_with_roles and a
// source clip in video_with_roles, each in the order of `roles`.
export type SeedanceMediaRole = "first_frame" | "last_frame" | "reference_video";
function seedanceMediaEntry<Operation extends string, Mode extends string, Label extends string>(
	operation: Operation,
	mode: Mode,
	label: Label,
	roles: readonly SeedanceMediaRole[],
) {
	return {
		...seedanceOperation,
		profile: `seedance-${mode}` as `seedance-${Mode}`,
		key: { ...seedanceOperation.key, operation },
		mode,
		label,
		roles,
	} as const;
}

export const seedanceKeyframeOperations = [
	seedanceMediaEntry("first-frame-to-video", "animate", "Animate a still", ["first_frame"]),
	seedanceMediaEntry("first-and-last-frame-to-video", "interpolate", "First and last frame", [
		"first_frame",
		"last_frame",
	]),
] as const;
// An edit follows its source, and ToAPIs caps neither. Upstream caps it at 30 s, unverified on
// this route (2026-11-24). https://docs.toapis.com/docs/en/api-reference/videos/seedance-2-5/generation:
// "Editing accepts only -1, and the output length matches the input video."
// https://toapis.com/model-guide/seedance-2-5: "Generate, edit, and extend up to 30-second videos."
// https://ai.byteplus.com/ark/region:ap-southeast-1/docs/seedance-2-5 (video duration): "The input
// video to be edited must be [4, 30] seconds long."
const seedanceEditSave = { seconds: 30, basis: "upstream" } as SaveLimit | null;
export const seedanceEditOperation = {
	...seedanceMediaEntry("video-edit", "edit", "Edit video", ["reference_video"]),
	save: seedanceEditSave,
} as const;
export const seedanceOperations = [
	seedanceOperation,
	...seedanceKeyframeOperations,
	seedanceEditOperation,
] as const;

// The Poyo video family shares one route, envelope, status and Save contract. Each row is a
// reviewed descriptor. H3 Max is the family's verified representative with partial options.
function poyoVideoEntry<Model extends string, Descriptor extends PoyoVideoDescriptor>(
	descriptor: Descriptor & { model: Model },
) {
	return {
		modelId: descriptor.model,
		profile: `${descriptor.model}-generate` as `${Model}-generate`,
		key: {
			provider: "poyo",
			model: descriptor.model,
			route: "POST /api/generate/submit",
			operation: descriptor.operation,
		},
		mode: "generate",
		label: "Create video",
		evidence: { d4: "declared", catalogD4: "declared" },
		save: descriptor.save,
		descriptor,
	} as const;
}

export const h3MaxOperation = poyoVideoEntry(h3Max);
export const poyoVideoOperations = [h3MaxOperation] as const;

export const releasedImageOperations = [
	seedreamEntry("poyo", "text-to-image"),
	seedreamEntry("poyo", "reference-image-edit"),
	seedreamEntry("toapis", "text-to-image"),
	seedreamEntry("toapis", "reference-image-edit"),
	zImageEntry("text-to-image"),
	zImageEntry("reference-image-edit"),
];
export const releasedVideoOperations = [...seedanceOperations, ...poyoVideoOperations] as const;
export const releasedOperations = [...releasedImageOperations, ...releasedVideoOperations];
export const releasedProviders = [
	...new Set(releasedOperations.map((entry) => entry.key.provider)),
];

export function resolveOperationKey(value: unknown) {
	if (
		!value ||
		typeof value !== "object" ||
		Object.keys(value).length !== 4 ||
		!("provider" in value && "model" in value && "route" in value && "operation" in value)
	)
		return undefined;
	return releasedOperations.find(
		({ key }) =>
			key.provider === value.provider &&
			key.model === value.model &&
			key.route === value.route &&
			key.operation === value.operation,
	);
}

export type SeedanceOperation = (typeof seedanceOperations)[number];
export type PoyoVideoOperation = (typeof poyoVideoOperations)[number];
export type ReleasedImageOperation = (typeof releasedImageOperations)[number];
export type SeedreamOperation = ReleasedImageOperation["mode"];

export function seedreamOperation(provider: ProviderId, mode: SeedreamOperation) {
	return releasedImageOperations.find(
		(entry) =>
			entry.modelId === seedreamModel.id && entry.key.provider === provider && entry.mode === mode,
	);
}
