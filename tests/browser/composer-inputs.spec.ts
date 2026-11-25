import { fileURLToPath } from "node:url";
import { expect, type Page } from "@playwright/test";
import { test } from "./studio-test";

async function openComposer(page: Page, kind: "image" | "video", provider: string) {
	const entry = "http://127.0.0.1/composer-test";
	await page.route(entry, (route) =>
		route.fulfill({ contentType: "text/html", body: "<main></main>" }),
	);
	await page.goto(entry);
	for (const script of ["fixtures", "state", "models", "studios"]) {
		await page.addScriptTag({
			path: fileURLToPath(new URL(`../../design/workspace/${script}.js`, import.meta.url)),
		});
	}
	await page.evaluate(
		({ kind, provider }) => {
			Reflect.get(window, "Studio").configure({ keys: { [provider]: true } });
			Reflect.get(window, "StudioViews").studios(document.querySelector("main"), kind);
		},
		{ kind, provider },
	);
}

test("Z-Image edits enforce the model's image formats and byte limit", async ({ page }) => {
	await openComposer(page, "image", "poyo");
	await page.locator("#studio-model").selectOption("z-image");
	await page.locator("#studio-operation").selectOption("edit");
	const file = page.locator("[data-source-file]");
	expect((await file.getAttribute("accept"))?.split(",")).toEqual([
		"image/jpeg",
		".jpg",
		".jpeg",
		"image/png",
		".png",
		"image/webp",
		".webp",
	]);
	await file.setInputFiles({
		name: "oversized.png",
		mimeType: "image/png",
		buffer: Buffer.alloc(10_000_001),
	});
	await expect(page.getByText(/Choose a non-empty .* up to 10 MB/)).toBeVisible();
});

test("Seedance defaults to text generation and shows the Poyo.ai schema conflict in Review", async ({
	page,
}) => {
	await openComposer(page, "video", "toapis");
	await page.locator("#studio-model").selectOption("seedance-2.5");
	await expect(page.locator("#studio-operation")).toHaveValue("generate");
	await page.evaluate(() =>
		Reflect.get(window, "Studio").configure({ keys: { poyo: true, toapis: true } }),
	);
	await page.getByRole("radio", { name: "Poyo.ai", exact: true }).check();
	await expect(
		page.getByText(/Poyo\.ai’s published Seedance schema excludes enable_safety_checker/),
	).toBeVisible();
});

test("the outgoing edit request hides the private path and query of a source URL", async ({
	page,
}) => {
	await openComposer(page, "image", "poyo");
	await page.locator("#studio-model").selectOption("z-image");
	await page.locator("#studio-operation").selectOption("edit");
	await page.locator(".studio-source-url summary").click();
	await page
		.locator("[data-source-url]")
		.fill("https://example.invalid/private-frame.png?token=fixture-secret");
	await page.getByRole("button", { name: "Use URL", exact: true }).click();
	await page.getByText("Outgoing request", { exact: true }).click();
	const preview = page.locator("[data-studio-wire-inner]");
	await expect(preview).toContainText("[remote URL hidden]");
	await expect(preview).not.toContainText("private-frame.png");
	await expect(preview).not.toContainText("fixture-secret");
});
