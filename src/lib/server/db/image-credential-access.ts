import { type SQL, sql } from "drizzle-orm";
import { seedreamRoutes } from "../../shared/media-catalog/registry";
import type { ProviderId } from "../../shared/providers/connections";

export type ImageCredentialAccess = "seedream" | "poyo-balance";
/** The connection check that a job's key must have passed. */
export type CredentialAccess = ImageCredentialAccess | "toapis-video";

// Only the shipped Seedream 5.5 operations need the key's Seedream check. Every other Poyo.ai
// image model, Z-Image and the derived rows, needs a balance-verified key (spec, condition 5).
const seedreamOnPoyo = seedreamRoutes.poyo.model;

export function imageCredentialAccess(provider: ProviderId, model: string): ImageCredentialAccess {
	return provider === "poyo" && model !== seedreamOnPoyo ? "poyo-balance" : "seedream";
}

// Both claim and recovery queries name the provider_credential row c.
export function credentialPermitsImage(model: SQL | string) {
	return sql`(c.seedream=1 OR (c.provider='poyo' AND ${model}<>${seedreamOnPoyo}))`;
}
