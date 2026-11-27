import { seedreamProviderNames } from "#lib/shared/image-studio/seedream-options.ts";
import { reviewOnlyVideoRows } from "#lib/shared/media-catalog/picker.ts";
import { releasedVideoOperations, seedanceOperation } from "#lib/shared/media-catalog/registry.ts";
import ledger from "../../../docs/media-catalog.v1.json";
import type { PageServerLoad } from "./$types";

const providers = ["poyo", "toapis"] as const;
const releasedFamilies = ["seedance", "hailuo"];
// A derived Poyo.ai row is listed once, with its Review-only reason, in its own family group.
const derived = new Set(reviewOnlyVideoRows.map((row) => row.model));

export const load: PageServerLoad = ({ url }) => {
	const routes = ledger.families
		.filter((family) => releasedFamilies.includes(family.id))
		.map((family) => ({
			label: family.label,
			routes: family.models.flatMap((model) =>
				providers.flatMap((provider) =>
					model[provider].flatMap((id) => {
						if (provider === "poyo" && derived.has(id)) return [];
						// Each provider record answers for itself, so ToAPIs H3 Max never borrows Poyo's route.
						const operation = releasedVideoOperations.find(
							(entry) => entry.key.provider === provider && entry.key.model === id,
						);
						return {
							id,
							label: `${model.label} · ${seedreamProviderNames[provider]}`,
							reason: operation
								? null
								: `Not available on ${seedreamProviderNames[provider]} in this release`,
						};
					}),
				),
			),
		}));
	const requested = url.searchParams.get("model");
	return {
		routes,
		initialModel:
			releasedVideoOperations.find((entry) => entry.key.model === requested)?.key.model ??
			seedanceOperation.key.model,
	};
};
