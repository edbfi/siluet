export const providerIds = ["poyo", "toapis"] as const;
export type ProviderId = (typeof providerIds)[number];

export type ProviderConnectionStatus =
	| { id: ProviderId; state: "disconnected" | "reconnect" }
	| { id: ProviderId; state: "connected"; verifiedAt: number; seedream: boolean };
