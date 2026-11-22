import { seedreamRoutes } from "../../../shared/media-catalog/registry";
import {
	type CheckFetch,
	type ConnectionCheckResult,
	createConnectionCheck,
	isRecord,
} from "../connection-check";

function interpretImageModels(body: unknown): ConnectionCheckResult {
	if (
		!isRecord(body) ||
		body.success !== true ||
		body.object !== "list" ||
		!Array.isArray(body.data)
	)
		return { outcome: "unavailable" };
	const models: unknown[] = body.data;
	if (
		!models.every(
			(model): model is { id: string } =>
				isRecord(model) && typeof model.id === "string" && model.id.length > 0,
		)
	)
		return { outcome: "unavailable" };
	return {
		outcome: "accepted",
		seedream: models.some((model) => model.id === seedreamRoutes.toapis.model),
	};
}

export function checkToapisConnection(read: CheckFetch = fetch) {
	return createConnectionCheck(
		`${seedreamRoutes.toapis.origin}/v1/models?type=image`,
		interpretImageModels,
		read,
	);
}
