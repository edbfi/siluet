import { seedreamProviderNames } from "#lib/shared/image-studio/seedream.ts";
import { releasedVideoOperations } from "#lib/shared/media-catalog/registry.ts";
import ledger from "../../../docs/media-catalog.v1.json";
import type { PageServerLoad } from "./$types";

const providers = ["poyo", "toapis"] as const;
const releasedFamilies = ["seedance", "hailuo"];

// Each provider record answers for itself, so ToAPIs H3 Max never borrows Poyo's route.
function unavailable(provider: (typeof providers)[number], id: string) {
	const row = ledger.providers[provider].rows.find(
		(entry) =>
			entry.ids.includes(id) && (entry.operations as readonly string[]).includes("text-to-video"),
	);
	return row?.d4 === "conflict"
		? "Queue unavailable: filtering conflict"
		: `Not available on ${seedreamProviderNames[provider]} in this release`;
}

export const load: PageServerLoad = ({ url }) => {
	const routes = ledger.families
		.filter((family) => releasedFamilies.includes(family.id))
		.map((family) => ({
			label: family.label,
			routes: family.models.flatMap((model) =>
				providers.flatMap((provider) =>
					model[provider].map((id) => {
						const operation = releasedVideoOperations.find(
							(entry) => entry.key.provider === provider && entry.key.model === id,
						);
						return {
							id,
							label: `${model.label} · ${seedreamProviderNames[provider]}`,
							reason: operation ? null : unavailable(provider, id),
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
			"seedance-2-5",
	};
};
