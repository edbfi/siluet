import { type SQL, sql } from "drizzle-orm";
import { zImageModel } from "../../shared/media-catalog/registry";
import type { ProviderId } from "../../shared/providers/connections";

export type CredentialAccess = "seedream" | "poyo-balance";

const balanceAccepted = { provider: "poyo", model: zImageModel.id } as const;

export function imageCredentialAccess(provider: ProviderId, model: string): CredentialAccess {
	return provider === balanceAccepted.provider && model === balanceAccepted.model
		? "poyo-balance"
		: "seedream";
}

// Both claim and recovery queries name the provider_credential row c.
export function credentialPermitsImage(model: SQL | string) {
	return sql`(c.seedream=1 OR (c.provider=${balanceAccepted.provider} AND ${model}=${balanceAccepted.model}))`;
}
