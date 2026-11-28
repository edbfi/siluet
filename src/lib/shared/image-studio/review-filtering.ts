import {
	contractDeclaresField,
	type FilteringEvidence,
	type FilteringProvider,
	queueEvidenceProblem,
} from "../media-catalog/filtering";

const declaredFields = { poyo: "input.enable_safety_checker", toapis: "disable_nsfw" } as const;

/**
 * What an image Review shows for D4: why Queue is unavailable, and the field the route-evidence
 * note says the model contract declares. A shipped image Review binds no D4 wording, so only a
 * declared row with an OpenAPI spec queues there; a derived Review passes the wording it binds.
 * Only a declared row's note says "declares".
 */
export function imageReviewFiltering(
	evidence: FilteringEvidence,
	provider: FilteringProvider,
	bound: readonly string[] = [],
) {
	return {
		unavailable: queueEvidenceProblem(evidence, provider, bound),
		declaredField: contractDeclaresField(evidence) ? declaredFields[provider] : null,
	};
}
