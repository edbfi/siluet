import { fileURLToPath } from "node:url";
import { expect } from "@playwright/test";
import { test } from "./studio-test";

test("a late error from the previous image preserves the current preview", async ({ page }) => {
	await page.setContent("<main></main>");
	await page.evaluate(() => {
		const src = document.createElement("canvas").toDataURL();
		Object.assign(window, {
			Studio: {
				assets: () =>
					["First", "Second"].map((title) => ({
						id: title,
						title,
						src,
						mime: "image/png",
						kind: "image",
						createdAt: 0,
					})),
				subscribe: () => () => {},
				consumeAsset: () => null,
			},
		});
	});
	await page.addScriptTag({
		path: fileURLToPath(new URL("../../design/workspace/gallery.js", import.meta.url)),
	});
	await page.evaluate(() =>
		Reflect.get(window, "StudioViews").gallery(document.querySelector("main")),
	);
	await page.getByRole("button", { name: /First/ }).click();
	const dialog = page.getByRole("dialog");
	const previous = await dialog.getByRole("img", { name: "First" }).elementHandle();
	await dialog.getByRole("button", { name: "Next media" }).click();
	await previous?.evaluate((element) => element.dispatchEvent(new Event("error")));
	await expect(dialog.getByRole("img", { name: "Second" })).toBeVisible({ timeout: 1500 });
});
