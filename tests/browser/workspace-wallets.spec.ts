import { test as base, expect, type Locator, type Page } from "@playwright/test";

const workspace = new URL("../../design/workspace/index.html", import.meta.url);

const test = base.extend<{ externalRequests: string[] }>({
	externalRequests: [
		async ({ page }, use) => {
			const requests: string[] = [];
			await page.route(/^https?:/, async (route) => {
				requests.push(route.request().url());
				await route.abort();
			});
			await page.routeWebSocket(/^wss?:/, async (socket) => {
				requests.push(socket.url());
				await socket.close();
			});
			await use(requests);
			expect(requests, "opening and using wallets stays local").toEqual([]);
		},
		{ auto: true },
	],
});

type CachedBalance = { value: number; unit: string; asOf: number };
type TestProvider = { id: string; name: string; balance: CachedBalance };

async function seedConnections(page: Page, keys: Record<string, boolean>, toapisWallet = false) {
	await page.addInitScript(
		(settings) => {
			localStorage.setItem("siluet.workspace.v1", JSON.stringify({ version: 1, settings }));
		},
		{ onboarded: true, keys, wallet: { toapis: toapisWallet } },
	);
}

async function injectWalletData(
	page: Page,
	{
		providers = [],
		balances = {},
	}: {
		providers?: TestProvider[];
		balances?: Record<string, CachedBalance>;
	},
) {
	// Extend the cache and catalog when the file's classic scripts initialize them.
	await page.addInitScript(
		({ providers, balances }) => {
			const extraNames = Object.fromEntries(providers.map(({ id, name }) => [id, name]));
			const extraKeys = Object.fromEntries(providers.map(({ id }) => [id, true]));
			const cached = new Map(Object.entries(balances));
			for (const { id, balance } of providers) cached.set(id, balance);

			if (providers.length) {
				Object.defineProperty(window, "SiluetModels", {
					configurable: true,
					set(catalog: { providers: Record<string, string> }) {
						Object.defineProperty(window, "SiluetModels", {
							value: { ...catalog, providers: { ...catalog.providers, ...extraNames } },
							writable: true,
							configurable: true,
						});
					},
				});
			}
			Object.defineProperty(window, "Studio", {
				configurable: true,
				set(studio: {
					settings: () => { keys: Record<string, boolean> };
					balance: (id: string) => CachedBalance | { value: null; unit: string; asOf: null };
				}) {
					const { settings, balance } = studio;
					studio.settings = () => {
						const state = settings();
						return { ...state, keys: { ...state.keys, ...extraKeys } };
					};
					studio.balance = (id) => cached.get(id) ?? balance(id);
					Object.defineProperty(window, "Studio", {
						value: studio,
						writable: true,
						configurable: true,
					});
				},
			});
		},
		{ providers, balances },
	);
}

test.use({ locale: "en-US", timezoneId: "UTC" });

test("the wallet dialog shows separate cached amounts and timestamps, including a zero balance", async ({
	page,
}) => {
	const poyoAsOf = "2026-11-20T10:00:00.000Z";
	const toapisAsOf = "2026-11-21T12:30:00.000Z";
	await seedConnections(page, { poyo: true, toapis: true }, true);
	await injectWalletData(page, {
		balances: {
			poyo: { value: 0, unit: "credits", asOf: Date.parse(poyoAsOf) },
			toapis: { value: 24.8, unit: "USD", asOf: Date.parse(toapisAsOf) },
		},
	});
	await page.goto(workspace.href);
	const trigger = page.getByRole("button", { name: /^Wallets\b/ });
	const dialog = page.getByRole("dialog", { name: "Wallets" });
	await expect(trigger).toHaveAttribute("aria-haspopup", "dialog");
	await expect(trigger).toHaveAttribute("aria-controls", "wallet-dialog");
	await expect(trigger).toContainText("0 credits");
	await expect(dialog).toBeHidden();

	await trigger.focus();
	await page.keyboard.press("Enter");
	await expect(dialog).toBeVisible();
	await expect(dialog.getByRole("button", { name: "Close wallets" })).toBeFocused();
	await expect(dialog.getByRole("searchbox", { name: "Search providers" })).toHaveCount(0);
	const poyo = dialog.locator('[data-wallet-provider="poyo"]');
	const toapis = dialog.locator('[data-wallet-provider="toapis"]');
	await expect(poyo).toContainText("Poyo.ai");
	await expect(poyo.locator("[data-wallet-balance]")).toHaveText("0 credits");
	await expect(poyo.locator("time")).toBeVisible();
	await expect(poyo.locator("time")).toHaveAttribute("datetime", poyoAsOf);
	await expect(toapis).toContainText("ToAPIs");
	await expect(toapis.locator("[data-wallet-balance]")).toHaveText("$24.80");
	await expect(toapis.locator("time")).toBeVisible();
	await expect(toapis.locator("time")).toHaveAttribute("datetime", toapisAsOf);

	await page.keyboard.press("Escape");
	await expect(dialog).toBeHidden();
	await expect(trigger).toBeFocused();
});

test("the wallet distinguishes a connected account without balance access from a disconnected provider", async ({
	page,
}) => {
	await seedConnections(page, { toapis: true });
	await page.goto(workspace.href);
	await page.getByRole("button", { name: /^Wallets\b/ }).click();

	const dialog = page.getByRole("dialog", { name: "Wallets" });
	await expect(dialog.locator('[data-wallet-provider="poyo"]')).toHaveCount(0);
	const toapis = dialog.locator('[data-wallet-provider="toapis"]');
	await expect(toapis).toContainText("ToAPIs");
	await expect(toapis.locator("[data-wallet-balance]")).toHaveText(/unavailable/i);
	await expect(toapis.locator("time")).toHaveCount(0);
});

test("without connections the wallet opens Provider settings from its empty state", async ({
	page,
}) => {
	await page.goto(workspace.href);
	await page.getByRole("button", { name: "Explore without keys" }).click();
	await page.getByRole("button", { name: /^Wallets\b/ }).click();

	const dialog = page.getByRole("dialog", { name: "Wallets" });
	await expect(dialog.locator("[data-wallet-provider]")).toHaveCount(0);
	await dialog.getByRole("link", { name: "Provider settings" }).click();
	await expect(dialog).toBeHidden();
	await expect(page).toHaveURL(/#settings\/providers$/);
	await expect(page.getByRole("tab", { name: "Providers", exact: true })).toHaveAttribute(
		"aria-selected",
		"true",
	);
});

const manyProviders: TestProvider[] = Array.from({ length: 16 }, (_, index) => {
	const number = index + 1;
	return {
		id: `wallet-fixture-${number}`,
		name: `Provider ${number} with a long account name`,
		balance: { value: 100 + number, unit: "tokens", asOf: Date.UTC(2026, 10, 20, number) },
	};
});

function triggerSize(trigger: Locator) {
	return trigger.evaluate((button) => {
		const { width, height } = button.getBoundingClientRect();
		return { width, height };
	});
}

for (const { device, viewport } of [
	{ device: "desktop", viewport: { width: 1440, height: 900 } },
	{ device: "mobile", viewport: { width: 320, height: 640 } },
]) {
	test(`the ${device} wallet trigger stays the same size with 17 connections`, async ({ page }) => {
		await page.setViewportSize(viewport);
		await seedConnections(page, { poyo: true });
		await page.goto(workspace.href);
		const trigger = page.getByRole("button", { name: /^Wallets\b/ });
		await expect(trigger).toBeInViewport({ ratio: 1 });
		const originalSize = await triggerSize(trigger);

		await injectWalletData(page, {
			providers: manyProviders,
			balances: {
				poyo: { value: 98_765_432.1, unit: "credits", asOf: Date.UTC(2026, 10, 20) },
			},
		});
		await page.reload();
		const dialog = page.getByRole("dialog", { name: "Wallets" });
		await expect(dialog).toBeHidden();
		await expect(trigger).toBeInViewport({ ratio: 1 });
		await expect(trigger).toContainText("98,765,432.1 credits");
		await expect(trigger).not.toContainText("Provider 16");
		expect(await triggerSize(trigger)).toEqual(originalSize);

		await trigger.click();
		await expect(dialog).toBeInViewport({ ratio: 1 });
		const rows = dialog.locator("[data-wallet-provider]");
		await expect(rows).toHaveCount(17);
		const lastProvider = dialog.locator('[data-wallet-provider="wallet-fixture-16"]');
		await expect(lastProvider).not.toBeInViewport();
		await dialog.getByRole("region", { name: "Provider balances" }).press("End");
		await expect(lastProvider).toBeInViewport({ ratio: 1 });
		await expect(dialog).toBeInViewport({ ratio: 1 });

		const search = dialog.getByRole("searchbox", { name: "Search providers" });
		await search.fill("provider 16");
		await expect(lastProvider).toBeVisible();
		await expect(lastProvider.locator("[data-wallet-balance]")).toHaveText("116 tokens");
		await expect(rows.filter({ visible: true })).toHaveCount(1);
		await search.clear();
		await expect(rows.filter({ visible: true })).toHaveCount(17);

		await dialog.getByRole("button", { name: "Close wallets" }).click();
		await expect(dialog).toBeHidden();
		await expect(trigger).toBeFocused();
	});
}
