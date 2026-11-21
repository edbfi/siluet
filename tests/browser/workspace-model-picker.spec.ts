import { expect, type Page, test } from "@playwright/test";

const entry = new URL("../../design/workspace/index.html", import.meta.url).href;

async function startWithPoyo(page: Page) {
	await page.goto(`${entry}#settings/providers/poyo`);
	await page.getByRole("button", { name: "Explore without keys" }).click();
	await page.getByRole("button", { name: "Set demo key for Poyo.ai" }).click();
}

test("image models are grouped by family and expose only configured API providers", async ({
	page,
}) => {
	await startWithPoyo(page);
	await page.getByRole("link", { name: "Image Studio", exact: true }).click();
	const models = page.locator("#studio-model");
	await expect(
		models.locator('optgroup[label="Alibaba / Qwen"] option[value="qwen-image-3.0"]'),
	).toBeAttached();
	await models.selectOption("seedream-5.5");
	await expect(models.locator('option[value="seedream-5.5"]')).toHaveCount(1);
	await expect(page.getByRole("radio", { name: "Poyo.ai", exact: true })).toBeChecked();
	await expect(page.getByRole("radio", { name: "ToAPIs", exact: true })).toHaveCount(0);
	await page.locator("#studio-prompt").fill("Evening light on wet stone");

	await page.getByRole("link", { name: "Settings", exact: true }).click();
	await page.getByRole("tab", { name: "ToAPIs", exact: true }).click();
	await page.getByRole("button", { name: "Set demo key for ToAPIs" }).click();
	await page.getByRole("link", { name: "Image Studio", exact: true }).click();
	await expect(models).toHaveValue("seedream-5.5");
	await expect(page.getByRole("group", { name: "API provider" }).getByRole("radio")).toHaveCount(2);
	await page.getByRole("radio", { name: "ToAPIs", exact: true }).check();
	await expect(page.locator("#studio-prompt")).toHaveValue("Evening light on wet stone");
	await page.getByText("Outgoing request", { exact: true }).click();
	const wire = page.locator("[data-studio-wire-inner]");
	await expect(wire).toContainText("doubao-seedream-5-5");
	await expect(wire).toContainText("disable_nsfw");
	await page.getByRole("radio", { name: "Poyo.ai", exact: true }).check();
	await expect(wire).toContainText("input.enable_safety_checker");
	await expect(wire).not.toContainText("doubao-seedream-5-5");
});

test("each Seedance API provider supplies its own video operations", async ({ page }) => {
	await page.goto(`${entry}#video`);
	await page.getByRole("button", { name: "Explore without keys" }).click();
	await page.locator("#studio-model").selectOption("seedance-2.5");
	const providers = page.getByRole("group", { name: "API provider", exact: true });
	await expect(providers.getByRole("radio")).toHaveCount(0);
	await expect(page.getByRole("button", { name: /^Queue / })).toBeDisabled();
	await page.getByRole("link", { name: "Settings", exact: true }).click();
	await page.getByRole("tab", { name: "Poyo.ai", exact: true }).click();
	await page.getByRole("button", { name: "Set demo key for Poyo.ai" }).click();
	await page.getByRole("link", { name: "Video Studio", exact: true }).click();
	await expect(providers.getByRole("radio")).toHaveCount(1);
	await expect(providers.getByRole("radio", { name: "Poyo.ai", exact: true })).toBeChecked();
	await page.getByRole("link", { name: "Settings", exact: true }).click();
	await page.getByRole("tab", { name: "ToAPIs", exact: true }).click();
	await page.getByRole("button", { name: "Set demo key for ToAPIs" }).click();
	await page.getByRole("link", { name: "Video Studio", exact: true }).click();
	await expect(page.locator("#studio-model")).toHaveValue("seedance-2.5");
	await expect(providers.getByRole("radio")).toHaveCount(2);
	await page.getByRole("radio", { name: "Poyo.ai", exact: true }).check();
	const operations = page.locator("#studio-operation");
	await expect(operations.locator('option[value="edit"]')).toHaveCount(0);
	await page.getByRole("radio", { name: "ToAPIs", exact: true }).check();
	await operations.selectOption("edit");
	await expect(page.locator("[data-source-file]").first()).toBeAttached();
	await page.getByRole("radio", { name: "Poyo.ai", exact: true }).check();
	await expect(operations).not.toHaveValue("edit");
	await expect(operations.locator('option[value="edit"]')).toHaveCount(0);
});

test("a catalog-only draft becomes runnable through the account connected in Settings", async ({
	page,
}) => {
	await page.goto(`${entry}#image`);
	await page.getByRole("button", { name: "Explore without keys" }).click();
	const models = page.locator("#studio-model");
	const providers = page.locator('input[name="studio-provider"]');
	const queue = page.getByRole("button", { name: /^Queue / });
	await models.selectOption("qwen-image-3.0-pro");
	await expect(providers).toHaveCount(0);
	await expect(queue).toBeDisabled();
	await page.locator("#studio-prompt").fill("Blue shadows on a ceramic bowl");
	await page.getByRole("link", { name: "Settings", exact: true }).click();
	await page.getByRole("tab", { name: "ToAPIs", exact: true }).click();
	await page.getByRole("button", { name: "Set demo key for ToAPIs" }).click();
	await page.getByRole("link", { name: "Image Studio", exact: true }).click();
	await expect(models).toHaveValue("qwen-image-3.0-pro");
	await expect(providers).toHaveCount(1);
	await expect(page.getByRole("radio", { name: "ToAPIs", exact: true })).toBeChecked();
	await expect(page.locator("#studio-prompt")).toHaveValue("Blue shadows on a ceramic bowl");
	await expect(queue).toBeEnabled();
});

const studioRoutes = [
	{
		kind: "image",
		sharedModel: "seedream-5.5",
		twoProviderModel: "z-image",
		toapisRoute: "doubao-seedream-5-5",
		toapisField: "#studio-size-mode",
	},
	{
		kind: "video",
		sharedModel: "seedance-2.5",
		twoProviderModel: "h3-max",
		toapisRoute: "seedance-2-5",
		toapisField: '#studio-operation option[value="edit"]',
	},
] as const;

async function addProviderFixtures(page: Page, routes: (typeof studioRoutes)[number]) {
	await page.addInitScript(({ kind, sharedModel, twoProviderModel }) => {
		type Route = { id: string; provider: string; modelKey: string };
		type Catalog = Record<"image" | "video", Route[]> & { providers: Record<string, string> };
		// Extend the connection state and catalog as the workspace scripts initialize them.
		localStorage.setItem(
			"siluet.workspace.v1",
			JSON.stringify({
				version: 1,
				settings: { onboarded: true, keys: { poyo: true, toapis: true } },
			}),
		);
		Object.defineProperty(window, "Studio", {
			configurable: true,
			set(studio: { settings: () => { keys: Record<string, boolean> } }) {
				const { settings } = studio;
				studio.settings = () => {
					const state = settings();
					return { ...state, keys: { ...state.keys, fixture: true } };
				};
				Object.defineProperty(window, "Studio", {
					value: studio,
					writable: true,
					configurable: true,
				});
			},
		});
		Object.defineProperty(window, "SiluetModels", {
			configurable: true,
			set(catalog: Catalog) {
				const routes = catalog[kind];
				const cloneRoute = (modelKey: string, provider: string) => {
					const sample = routes.find(
						(route) => route.modelKey === modelKey && route.provider === "poyo",
					);
					if (!sample) throw new Error(`Missing Poyo sample route for ${modelKey}`);
					return { ...sample, provider, id: `${provider}-${sample.id}`, promptMax: 2048 };
				};
				catalog.providers.fixture = "Fixture API";
				catalog.providers.disconnected = "Disconnected API";
				routes.push(
					cloneRoute(sharedModel, "fixture"),
					cloneRoute(twoProviderModel, "fixture"),
					cloneRoute(sharedModel, "disconnected"),
				);
				Object.defineProperty(window, "SiluetModels", {
					value: catalog,
					writable: true,
					configurable: true,
				});
			},
		});
	}, routes);
}

for (const routes of studioRoutes) {
	test(`${routes.kind} studio adapts the provider control to connected routes for the selected model`, async ({
		page,
	}) => {
		const externalRequests: string[] = [];
		await page.route(/^https?:/, async (route) => {
			externalRequests.push(route.request().url());
			await route.abort();
		});
		await addProviderFixtures(page, routes);
		await page.goto(`${entry}#${routes.kind}`);
		const models = page.locator("#studio-model");
		await models.selectOption(routes.sharedModel);
		const provider = page.getByRole("combobox", { name: "API provider", exact: true });
		await expect(provider).toHaveAttribute("id", "studio-api-provider");
		await expect(provider).toHaveJSProperty("tagName", "SELECT");
		await expect(provider.getByRole("option")).toHaveText(["Poyo.ai", "ToAPIs", "Fixture API"]);

		const prompt = page.locator("#studio-prompt");
		const draft = "Soft light on a windblown shoreline";
		await prompt.fill(draft);
		await page.getByText("Outgoing request", { exact: true }).click();
		const review = page.getByRole("region", { name: "Review request" });
		const reviewProvider = review.getByRole("definition").first();
		const wire = review.locator("[data-studio-wire-inner]");
		const queue = review.getByRole("button", { name: /^Queue / });
		const toapisField = page.locator(routes.toapisField);
		await provider.selectOption({ label: "Fixture API" });
		await expect(provider).toHaveValue("fixture");
		await expect(reviewProvider).toContainText("Fixture API");
		await expect(wire).toHaveText("Request preview is unavailable for this API provider.");
		await expect(queue).toBeDisabled();
		await expect(prompt).toHaveAttribute("maxlength", "2048");
		await expect(toapisField).toHaveCount(0);
		await expect(prompt).toHaveValue(draft);

		await provider.press("ArrowUp");
		await expect(provider).toHaveValue("toapis");
		await expect(provider).toBeFocused();
		await expect(reviewProvider).toContainText("ToAPIs");
		await expect(wire).toContainText(`model ${routes.toapisRoute}`);
		await expect(wire).toContainText("disable_nsfw = false");
		await expect(queue).toBeEnabled();
		await expect(toapisField).toBeAttached();
		await expect(prompt).toHaveValue(draft);

		await models.selectOption(routes.twoProviderModel);
		await expect(provider).toHaveCount(0);
		const providerGroup = page.getByRole("group", { name: "API provider", exact: true });
		await expect(providerGroup.getByRole("radio")).toHaveCount(2);
		await expect(providerGroup.getByRole("radio", { name: "Poyo.ai", exact: true })).toBeChecked();
		await expect(
			providerGroup.getByRole("radio", { name: "Fixture API", exact: true }),
		).toBeVisible();
		await expect(reviewProvider).toContainText("Poyo.ai");
		await expect(prompt).toHaveValue(draft);
		expect(externalRequests).toEqual([]);
	});
}
