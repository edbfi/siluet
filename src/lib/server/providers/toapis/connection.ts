import { seedanceOperation, seedreamRoutes } from "../../../shared/media-catalog/registry";
import {
	type CheckFetch,
	type ConnectionCheck,
	createConnectionCheck,
	isRecord,
} from "../connection-check";

function interpretModels(
	body: unknown,
	id: string,
): { outcome: "accepted"; listed: boolean } | { outcome: "unavailable" } {
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
		listed: models.some((model) => model.id === id),
	};
}

export function checkToapisConnection(read: CheckFetch = fetch): ConnectionCheck {
	const check = createConnectionCheck<{ outcome: "accepted"; listed: boolean }>(
		`${seedreamRoutes.toapis.origin}/v1/models?type=image`,
		(body) => interpretModels(body, seedreamRoutes.toapis.model),
		read,
	);
	return async (key) => {
		const result = await check(key);
		return result.outcome === "accepted"
			? { outcome: "accepted", seedream: result.listed }
			: result;
	};
}

export function checkVideoInventory(read: CheckFetch = fetch) {
	return createConnectionCheck<{ outcome: "accepted"; listed: boolean }>(
		"https://toapis.com/v1/models?type=video",
		(body) => interpretModels(body, seedanceOperation.key.model),
		read,
	);
}
