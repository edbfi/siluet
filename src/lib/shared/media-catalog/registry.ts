import type { ProviderId } from "../providers/connections";

// The browser needs only released operations. The ledger test reconciles these
// exact keys against the dated inventory and its explicit family aliases.
export const seedreamModel = {
	id: "seedream-5.5",
	label: "Seedream 5.5",
	family: "ByteDance / Seedream",
} as const;

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
		key: { provider, model, route: `POST ${path}`, operation },
		...ordinaryOperations[operation],
		evidence: seedreamEvidence,
	};
}

export const releasedOperations = [
	seedreamEntry("poyo", "text-to-image"),
	seedreamEntry("poyo", "reference-image-edit"),
	seedreamEntry("toapis", "text-to-image"),
	seedreamEntry("toapis", "reference-image-edit"),
];
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

export type ReleasedOperation = (typeof releasedOperations)[number];
export type SeedreamOperation = ReleasedOperation["mode"];

export function seedreamOperation(provider: ProviderId, mode: SeedreamOperation) {
	return releasedOperations.find((entry) => entry.key.provider === provider && entry.mode === mode);
}
