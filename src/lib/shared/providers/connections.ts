export const providerIds = ["poyo", "toapis"] as const;
export type ProviderId = (typeof providerIds)[number];

export const providerStorageRepairMessage =
	"Restore private access to the installation directory and its provider-credentials.key file. Move any link at the key path aside, then reload Settings.";

export type ProviderConnectionStatus =
	| { id: ProviderId; state: "disconnected" | "reconnect" }
	| { id: ProviderId; state: "repair"; hasCredential: boolean }
	| { id: ProviderId; state: "connected"; verifiedAt: number; seedream: boolean };
