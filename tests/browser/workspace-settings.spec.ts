import { expect, test } from "@playwright/test";

const workspace = new URL("../../design/workspace/index.html", import.meta.url);

test("appearance follows the system until the creator chooses a persistent override", async ({
	page,
}) => {
	await page.emulateMedia({ colorScheme: "dark" });
	await page.goto(`${workspace.href}#settings/appearance`);
	await page.getByRole("button", { name: "Explore without keys" }).click();
	const root = page.locator("html");
	await expect(page.getByRole("tab", { name: "Appearance" })).toHaveAttribute(
		"aria-selected",
		"true",
	);
	await expect(root).toHaveCSS("color-scheme", "dark");
	await page.getByRole("radio", { name: /light/i }).check();
	await expect(root).toHaveAttribute("data-theme", "light");
	await page.reload();
	await expect(page.getByRole("radio", { name: /light/i })).toBeChecked();
	await expect(root).toHaveAttribute("data-theme", "light");
	await page.getByRole("radio", { name: /system/i }).check();
	await expect(root).toHaveAttribute("data-theme", "dark");
	await page.emulateMedia({ colorScheme: "light" });
	await expect(root).toHaveCSS("color-scheme", "light");
	await page.getByRole("radio", { name: /dark/i }).check();
	await page.getByRole("link", { name: "Gallery", exact: true }).click();
	await expect(page.getByRole("heading", { name: "Gallery", exact: true })).toBeVisible();
	await expect(root).toHaveCSS("color-scheme", "dark");
});

test("studio retry settings opens the Generation tab and Back returns to the draft", async ({
	page,
}) => {
	await page.goto(`${workspace.href}#image`);
	await page.getByRole("button", { name: "Explore without keys" }).click();
	const prompt = page.locator("#studio-prompt");
	await prompt.fill("Cobalt glaze on white stoneware");
	await page.getByRole("button", { name: "Retry settings" }).click();
	await expect(page.getByRole("tab", { name: "Generation" })).toHaveAttribute(
		"aria-selected",
		"true",
	);
	await expect(page.getByRole("switch", { name: "Automatic retries" })).toBeVisible();
	await page.goBack();
	await expect(prompt).toHaveValue("Cobalt glaze on white stoneware");
});

test("keyboard navigation selects one Settings panel and preserves its controls", async ({
	page,
}) => {
	await page.goto(`${workspace.href}#settings`);
	await page.getByRole("button", { name: "Explore without keys" }).click();
	const providers = page.getByRole("tab", { name: "Providers" });
	const privacy = page.getByRole("tab", { name: "Privacy" });
	const appearance = page.getByRole("tab", { name: "Appearance" });
	await providers.focus();
	await providers.press("End");
	await expect(appearance).toBeFocused();
	await appearance.press("ArrowLeft");
	await expect(privacy).toBeFocused();
	const ip = page.getByRole("button", { name: /Check outgoing IP/ });
	await ip.click();
	await expect(page.getByText("203.0.113.42 (simulated)")).toBeVisible();
	await privacy.focus();
	await privacy.press("Home");
	await expect(providers).toBeFocused();
	await expect(ip).toHaveCount(0);
	await privacy.click();
	await expect(page.getByText("203.0.113.42 (simulated)")).toBeVisible();
	await expect(page.getByRole("tabpanel")).toHaveCount(1);
});

test("provider tabs isolate connection controls and support keyboard, history and reload", async ({
	page,
}) => {
	await page.setViewportSize({ width: 320, height: 700 });
	await page.goto(`${workspace.href}#settings/providers`);
	await page.getByRole("button", { name: "Explore without keys" }).click();
	const picker = page.getByRole("tablist", { name: "Provider connections" });
	const poyo = picker.getByRole("tab", { name: "Poyo.ai" });
	const toapis = picker.getByRole("tab", { name: "ToAPIs" });
	const wallet = page.getByRole("switch", { name: "Show ToAPIs balance" });
	await expect(poyo).toHaveAttribute("aria-selected", "true");
	await expect(wallet).toHaveCount(0);
	await toapis.click();
	await page.getByRole("button", { name: "Set demo key for ToAPIs" }).click();
	await wallet.check();
	await page.reload();
	await expect(toapis).toHaveAttribute("aria-selected", "true");
	await expect(page.getByRole("button", { name: "Remove demo key for ToAPIs" })).toBeVisible();
	await expect(wallet).toBeChecked();
	await poyo.click();
	await expect(page.getByRole("button", { name: "Set demo key for Poyo.ai" })).toBeVisible();
	await expect(wallet).toHaveCount(0);
	await page.goBack();
	await expect(toapis).toHaveAttribute("aria-selected", "true");
	await toapis.press("ArrowLeft");
	await expect(poyo).toBeFocused();
	await expect(page.getByRole("tab", { name: "Providers", exact: true })).toHaveAttribute(
		"aria-selected",
		"true",
	);
});

test("entering Providers from an Appearance deep link opens an actionable connection", async ({
	page,
}) => {
	await page.goto(`${workspace.href}#settings/appearance`);
	await page.getByRole("button", { name: "Explore without keys" }).click();
	await page.getByRole("tab", { name: "Appearance" }).press("Home");
	await expect(page.getByRole("button", { name: "Set demo key for Poyo.ai" })).toBeVisible();
});
