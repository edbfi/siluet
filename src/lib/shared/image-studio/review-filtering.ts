import {
	contractDeclaresField,
	type FilteringEvidence,
	type FilteringProvider,
	queueEvidenceProblem,
} from "../media-catalog/filtering";

const declaredFields = { poyo: "input.enable_safety_checker", toapis: "disable_nsfw" } as const;

/**
 * What an image Review shows for D4: why Queue is unavailable, and the field the route-evidence
 * note says the model contract declares. Image Reviews bind no D4 wording yet, so only a
 * declared row with an OpenAPI spec can queue, and only a declared row's note says "declares".
 */
export function imageReviewFiltering(evidence: FilteringEvidence, provider: FilteringProvider) {
	return {
		unavailable: queueEvidenceProblem(evidence, provider),
		declaredField: contractDeclaresField(evidence) ? declaredFields[provider] : null,
	};
}
