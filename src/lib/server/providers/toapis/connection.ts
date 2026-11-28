import { seedreamRoutes } from "../../../shared/media-catalog/registry";
import type { CheckFetch, ConnectionCheck } from "../connection-check";
import { readModelList } from "./model-list";

export function checkToapisConnection(read: CheckFetch = fetch): ConnectionCheck {
	const list = readModelList(read, { origin: seedreamRoutes.toapis.origin });
	return async (key) => {
		const result = await list(key, "image");
		if (result.outcome === "succeeded")
			return {
				outcome: "accepted",
				seedream: result.models.includes(seedreamRoutes.toapis.model),
				models: result.models,
			};
		return { outcome: result.outcome === "rejected" ? "rejected" : "unavailable" };
	};
}
