// The Image models and Video models sections of the ToAPIs Settings page.
import ledger from "../../../../../docs/media-catalog.v1.json";
import { seedanceOperation, seedreamOperation } from "../../../shared/media-catalog/registry";
import {
	accessText,
	type InventoryScope,
	listingCaveat,
} from "../../../shared/providers/inventory";
import type { Inventory } from "./inventory";

const shipped = {
	image: seedreamOperation("toapis", "generate")?.key,
	video: seedanceOperation.key,
} as const;

/** Every ToAPIs ledger ID of one output media, the shipped model first. */
function ledgerIds(scope: InventoryScope) {
	const ids = new Set(
		ledger.providers.toapis.rows.filter((row) => row.media === scope).flatMap((row) => row.ids),
	);
	const first = shipped[scope]?.model;
	return [...ids].sort((a, b) => Number(b === first) - Number(a === first) || a.localeCompare(b));
}

export type InventorySection = {
	scope: InventoryScope;
	/** The shipped model's access line: the outcome and its check time. */
	line: string;
	models: { id: string; status: "listed" | "absent" | "unknown" }[];
	caveat: string;
};

export async function inventorySection(
	inventory: Pick<Inventory, "access" | "snapshot">,
	scope: InventoryScope,
): Promise<InventorySection> {
	const key = shipped[scope];
	if (!key) throw new Error("Missing shipped ToAPIs operation.");
	const [access, snapshot] = await Promise.all([
		inventory.access(key, scope),
		inventory.snapshot(scope),
	]);
	const listed =
		snapshot?.fresh && snapshot.outcome === "succeeded" ? new Set(snapshot.models) : null;
	return {
		scope,
		line: accessText(access, key.model, scope),
		models: ledgerIds(scope).map((id) => ({
			id,
			status: listed ? (listed.has(id) ? "listed" : "absent") : "unknown",
		})),
		caveat: listingCaveat,
	};
}
