// What a ToAPIs model's access evidence says (docs/SPEC-catalog-engine.md "Shared ToAPIs
// inventory snapshot (G9)"). Browser-safe: Review, Settings and the claim share these rules.

/** The output media of a ToAPIs operation: the model list Siluet reads for it. */
export type InventoryScope = "image" | "video";
export const inventoryScopes = ["image", "video"] as const;

/** A snapshot this old, or dated in the future, is stale. */
export const inventoryFreshMs = 86_400_000;

export type InventoryKey = { provider: string; model: string; route: string; operation: string };

/**
 * The shipped ToAPIs operations that keep their pre-snapshot evidence, frozen here so a later
 * release cannot widen the exception. Each is the exact released key.
 */
export const preSnapshotOperations: readonly (InventoryKey & { scope: InventoryScope })[] = [
	...["text-to-image", "reference-image-edit"].map((operation) => ({
		scope: "image" as const,
		provider: "toapis",
		model: "doubao-seedream-5-5",
		route: "POST /v1/images/generations",
		operation,
	})),
	...["text-to-video", "first-frame-to-video", "first-and-last-frame-to-video", "video-edit"].map(
		(operation) => ({
			scope: "video" as const,
			provider: "toapis",
			model: "seedance-2-5",
			route: "POST /v1/videos/generations",
			operation,
		}),
	),
];

/** The model whose `model_access` record is the video exception's evidence. */
export const preSnapshotVideoModel = "seedance-2-5";

export function preSnapshotScope(key: InventoryKey): InventoryScope | null {
	return (
		preSnapshotOperations.find(
			(entry) =>
				entry.provider === key.provider &&
				entry.model === key.model &&
				entry.route === key.route &&
				entry.operation === key.operation,
		)?.scope ?? null
	);
}

export type InventoryOutcome = "succeeded" | "rejected" | "unavailable";

/** What resolution reads: the saved key, its snapshot and the pre-snapshot evidence. */
export type AccessInputs = {
	/** The readable saved key's revision, or null without one. */
	revision: number | null;
	snapshot: {
		revision: number;
		checkedAt: number;
		outcome: InventoryOutcome;
		models: readonly string[] | null;
	} | null;
	/** The Seedream flag in the saved key's authenticated data. */
	seedream: boolean;
	/** The shipped `model_access` record for Seedance 2.5. */
	modelAccess: { revision: number; state: string } | null;
};

export type AccessState =
	| "listed"
	| "absent"
	| "unchecked"
	| "failed"
	| "stale"
	| "disconnected"
	| "exception";

/** The access evidence a Review shows and binds: revision, state, check time and basis. */
export type ModelAccess = {
	state: AccessState;
	revision: number | null;
	checkedAt: number | null;
	basis: "snapshot" | "pre-snapshot" | "none";
	/** Why a recorded check failed. */
	failure?: "rejected" | "unavailable";
};

export const isFresh = (checkedAt: number, now: number) =>
	checkedAt <= now && now - checkedAt < inventoryFreshMs;

export function resolveAccess(
	key: InventoryKey,
	scope: InventoryScope,
	inputs: AccessInputs,
	now: number,
): ModelAccess {
	const { revision } = inputs;
	if (revision === null) return { state: "disconnected", revision, checkedAt: null, basis: "none" };
	const snapshot = inputs.snapshot?.revision === revision ? inputs.snapshot : null;
	if (!snapshot) {
		// Only while no snapshot exists for this revision, and never for a derived row.
		const exception =
			preSnapshotScope(key) === scope &&
			(scope === "image"
				? inputs.seedream
				: inputs.modelAccess?.revision === revision && inputs.modelAccess.state === "eligible");
		return exception
			? { state: "exception", revision, checkedAt: null, basis: "pre-snapshot" }
			: { state: "unchecked", revision, checkedAt: null, basis: "none" };
	}
	const { checkedAt, outcome } = snapshot;
	if (outcome !== "succeeded")
		return { state: "failed", revision, checkedAt, basis: "snapshot", failure: outcome };
	if (!isFresh(checkedAt, now)) return { state: "stale", revision, checkedAt, basis: "snapshot" };
	return {
		state: snapshot.models?.includes(key.model) ? "listed" : "absent",
		revision,
		checkedAt,
		basis: "snapshot",
	};
}

/** Only a fresh listing, or the frozen exception before any snapshot, allows Queue. */
export const accessQueues = (access: ModelAccess) =>
	access.state === "listed" || access.state === "exception";

/** The state of a check that could not reach ToAPIs, which records nothing. */
export const skippedText = "Siluet could not reach ToAPIs. Nothing was recorded.";
export const disconnectedText = "Connect a readable ToAPIs model key in Settings.";
export const uncheckedText = "Check ToAPIs model access.";
export const staleText = "The ToAPIs model list is more than 24 hours old. Check again.";
export const listingCaveat =
	"A listing is not evidence of entitlement, filtering compatibility or price.";
const exceptionText: Record<InventoryScope, string> = {
	image: "The global image model list included this model for this key.",
	video: "Seedance 2.5 was listed for this key.",
};

export const utcTime = (time: number) =>
	`${new Date(time).toISOString().slice(0, 19).replace("T", " ")} UTC`;

/** The line Settings and Review show for one exact model. */
export function accessText(access: ModelAccess, model: string, scope: InventoryScope) {
	const at = access.checkedAt === null ? "" : utcTime(access.checkedAt);
	switch (access.state) {
		case "listed":
			return `ToAPIs listed ${model} for this key at ${at}.`;
		case "absent":
			return `ToAPIs did not list ${model} for this key at ${at}.`;
		case "failed":
			return `The ToAPIs model check failed at ${at} (${access.failure === "rejected" ? "key refused" : "service unavailable"}). Check again.`;
		case "stale":
			return staleText;
		case "unchecked":
			return uncheckedText;
		case "disconnected":
			return disconnectedText;
		case "exception":
			return exceptionText[scope];
	}
}

export function rateLimitText(retryAfterSeconds: number) {
	return `Three checks a minute per scope. Try again in ${Math.max(1, Math.ceil(retryAfterSeconds))} s.`;
}
