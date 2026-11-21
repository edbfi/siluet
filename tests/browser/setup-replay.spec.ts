import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

test("setup replay keeps the connected provider in its review", async ({ page }) => {
	await page.setContent("<main></main>");
	await page.evaluate(() => {
		Object.assign(window, {
			Studio: {
				settings: () => ({ onboarded: true, keys: { poyo: true }, wallet: {} }),
				configure: (patch: unknown) => Reflect.set(window, "setupPatch", patch),
			},
		});
	});
	await page.addScriptTag({
		path: fileURLToPath(new URL("../../design/workspace/onboarding.js", import.meta.url)),
	});
	await page.evaluate(() => Reflect.get(window, "StudioViews").onboarding(true));
	const provider = page.getByRole("checkbox", { name: /Poyo/ });
	await expect(provider).toBeChecked();
	await expect(provider).toBeDisabled({ timeout: 1000 });
	await page.getByRole("button", { name: "Continue" }).click();
	await page.getByRole("button", { name: "Continue" }).click();
	await expect(page.getByText("Poyo.ai", { exact: true })).toBeVisible();
	await page.getByRole("button", { name: "Open studio" }).click();
	expect(await page.evaluate(() => Reflect.get(window, "setupPatch"))).toEqual({
		keys: { poyo: true },
		onboarded: true,
	});
});
