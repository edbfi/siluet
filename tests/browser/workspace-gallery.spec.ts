import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { expect, type Page } from "@playwright/test";
import { test } from "./studio-test";

const entry = new URL("../../design/workspace/workspace.html", import.meta.url).href;
test.beforeAll(() => {
	execFileSync(
		"bun",
		[fileURLToPath(new URL("../../design/workspace/export.js", import.meta.url))],
		{ stdio: "inherit" },
	);
});

test.beforeEach(async ({ context }) => {
	await context.setOffline(true);
});

async function openGallery(page: Page) {
	await page.goto(`${entry}#gallery`);
	await page.getByRole("button", { name: "Explore without keys" }).click();
	await expect(page.getByRole("heading", { name: "Gallery", exact: true })).toBeVisible();
}

test("gallery pages the fixtures and can play the bundled video offline", async ({ page }) => {
	await openGallery(page);
	const media = page.getByRole("list", { name: "Media" });
	await expect(media).toHaveCSS("display", "grid");
	await expect(media.getByRole("listitem")).toHaveCount(8);
	await page.getByRole("button", { name: "Next page" }).click();
	await expect(page.getByText("Page 2 of 2")).toBeVisible();
	await expect(page.getByRole("button", { name: "Previous page" })).toBeFocused();
	await expect(media.getByRole("listitem")).toHaveCount(8);

	const videos = page.getByRole("button", { name: /^Videos / });
	await videos.click();
	await expect(videos).toHaveAttribute("aria-pressed", "true");
	await expect(media.getByRole("listitem")).toHaveCount(2);
	const card = media.getByRole("button", { name: /Tide loop/ });
	await card.click();
	const dialog = page.getByRole("dialog", { name: "Tide loop" });
	const video = dialog.locator("video");
	await expect(video).toHaveJSProperty("controls", true);
	await video.evaluate((element: HTMLVideoElement) => element.play());
	await expect
		.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime))
		.toBeGreaterThan(0);
	await expect(dialog.getByRole("group", { name: "Image zoom" })).toBeHidden();
	await page.keyboard.press("Escape");
	await expect(dialog).toBeHidden();
	await expect(card).toBeFocused();
});

test("image viewer supports keyboard zoom and downloads the original fixture bytes", async ({
	page,
}) => {
	await openGallery(page);
	const card = page.getByRole("button", { name: /Tide study/ });
	await card.click();
	const dialog = page.getByRole("dialog", { name: "Tide study" });
	await expect
		.poll(() =>
			dialog
				.getByRole("img", { name: "Tide study" })
				.evaluate((image: HTMLImageElement) => image.naturalWidth),
		)
		.toBeGreaterThan(0);
	await page.keyboard.press("=");
	await expect(dialog.getByRole("button", { name: "Reset zoom to fit" })).toHaveText("150%");
	await page.keyboard.press("0");
	await expect(dialog.getByRole("button", { name: "Reset zoom to fit" })).toHaveText("Fit");
	const downloaded = page.waitForEvent("download");
	await dialog.getByRole("link", { name: "Download", exact: true }).click();
	const download = await downloaded;
	expect(download.suggestedFilename()).toMatch(/^siluet-\d{4}-\d{2}-\d{2}-[a-f0-9]{8}\.webp$/);
	const path = await download.path();
	expect(await readFile(path)).toEqual(
		await readFile(new URL("../../design/studio/media/tide-study.webp", import.meta.url)),
	);
});

test("gallery accepts valid local images, reports unsupported files, and clears imports on reload", async ({
	page,
}) => {
	await openGallery(page);
	await page.locator('input[type="file"]').setInputFiles([
		{
			name: "offline-import.png",
			mimeType: "image/png",
			buffer: await readFile(
				new URL("../../design/workspace/media/tidal-contours.png", import.meta.url),
			),
		},
		{ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("fixture notes") },
	]);
	await expect(page.getByText(/^1 file added\. 1 file skipped\./)).toBeVisible();
	const card = page.getByRole("button", { name: /offline-import.png/ });
	await card.click();
	await expect(page.getByRole("dialog")).toBeVisible();
	await page.reload();
	await expect(page.getByRole("heading", { name: "Gallery", exact: true })).toBeVisible();
	await expect(card).toHaveCount(0);
	await expect(page.getByRole("button", { name: /Tide study/ })).toBeVisible();
});
