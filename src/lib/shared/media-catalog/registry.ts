import type { ProviderId } from "../providers/connections";
import { h3Max } from "../video-studio/h3-max";
import type { PoyoVideoDescriptor } from "../video-studio/poyo-video";

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
} as const;

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
export const releasedVideoOperations = [seedanceOperation, ...poyoVideoOperations] as const;
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

export type ReleasedImageOperation = (typeof releasedImageOperations)[number];
export type SeedreamOperation = ReleasedImageOperation["mode"];

export function seedreamOperation(provider: ProviderId, mode: SeedreamOperation) {
	return releasedImageOperations.find(
		(entry) =>
			entry.modelId === seedreamModel.id && entry.key.provider === provider && entry.mode === mode,
	);
}
