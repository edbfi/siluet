import type { WalletScope } from "../../src/lib/shared/billing/wallet";

export type FixtureRead = { amount: string; forHistory?: true } | { retryAfterMs: number } | null;

export const walletFixtures = {
	poyo: {
		scope: { provider: "poyo", account: "poyo-demo-account", unit: "credits" },
		reads: [
			{ amount: "2480", forHistory: true },
			{ amount: "2476.8", forHistory: true },
			{ amount: "2476.8", forHistory: true },
			{ amount: "2475.1", forHistory: true },
			{ retryAfterMs: 3000 },
			{ amount: "2475.1" },
			{ amount: "2501" }, // The interval includes a simulated top-up.
			{ amount: "2501" },
			{ amount: "2499" }, // Another client used the account.
			{ amount: "2499" },
			null,
		],
	},
	toapis: {
		scope: { provider: "toapis", account: "toapis-demo-account", unit: "USD" },
		// These four reads cover two batches. Later reads simulate an unavailable wallet.
		reads: [{ amount: "24.8" }, { amount: "24.73" }, { amount: "24.73" }, { amount: "24.73" }],
	},
} satisfies Record<string, { scope: WalletScope; reads: FixtureRead[] }>;

export type DemoProvider = keyof typeof walletFixtures;
