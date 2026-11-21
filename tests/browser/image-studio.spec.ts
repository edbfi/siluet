import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { expect, type Page, test } from "@playwright/test";
import { createOwnerDirectory } from "../fixtures/owner-directory";
import {
	providerFixtureKeys as keys,
	startProviderFixtures,
} from "../fixtures/provider-connections";
import { referencePng } from "../fixtures/reference-image";
import { startStudio } from "./built-studio";

const username = "image-owner";
const promptText = "Blend image 1 and image 2 under soft evening light.";
const referenceUrl = "https://images.example.test/photos/fixture-edit.png?token=fixture-reference";
const referenceImage = {
	name: "fixture-reference.png",
	mimeType: "image/png",
	buffer: referencePng,
};

async function enterOwnerDetails(page: Page, password: string) {
	await page.getByLabel("Username", { exact: true }).fill(username);
	await page.getByLabel("Password", { exact: true }).fill(password);
}

async function saveKey(page: Page, key: string, button: "Connect" | "Replace key" = "Connect") {
	await page.getByLabel("API key").fill(key);
	await page.getByRole("button", { name: button, exact: true }).press("Enter");
	await expect(page.getByRole("status")).toHaveText("Key accepted and saved.");
}

test("built Image Studio uses eligible connections and keeps drafts in the signed-in page session", async ({
	page,
}) => {
	test.setTimeout(60_000);
	page.setDefaultTimeout(10_000);
	const directory = await createOwnerDirectory();
	const fixtures = startProviderFixtures();
	let studio: Awaited<ReturnType<typeof startStudio>> | undefined;
	try {
		const server = await startStudio(directory, "0", false, fixtures.env);
		studio = server;
		const { origin } = server;
		const imageUrl = new URL("/image", origin).href;
		const signInUrl = new URL("/sign-in", origin).href;
		const password = randomUUID();
		const outbound: string[] = [];
		const pageErrors: Error[] = [];
		page.on("pageerror", (error) => pageErrors.push(error));
		await page.route("**/*", (route) => {
			const url = new URL(route.request().url());
			if (url.origin === origin.origin) return route.continue();
			outbound.push(url.origin);
			return route.abort();
		});

		await test.step("claim the owner from the protected Image Studio URL", async () => {
			await expect.poll(server.token).not.toBe("");
			await page.goto(imageUrl);
			await expect(page).toHaveURL(new URL("/setup", origin).href);
			await page.getByLabel("Claim token").fill(server.token());
			await enterOwnerDetails(page, password);
			await page.getByRole("button", { name: "Claim studio" }).press("Enter");
			await expect(page).toHaveURL(origin.href);
			await expect(page.getByRole("heading", { name: "Studio home" })).toBeVisible();
		});

		const navigation = page.getByRole("navigation", { name: "Studio navigation" });
		const imageLink = navigation.getByRole("link", { name: "Image Studio", exact: true });
		const settingsLink = navigation.getByRole("link", { name: "Settings", exact: true });
		const homeLink = navigation.getByRole("link", { name: "Studio home", exact: true });
		const model = page.getByLabel("Model", { exact: true });
		const prompt = page.getByRole("textbox", { name: "Prompt", exact: true });
		const providers = page
			.getByRole("group", { name: "API provider", exact: true })
			.getByRole("radio");
		const operation = page.getByLabel("Operation", { exact: true });
		const poyo = page.getByRole("radio", { name: "Poyo.ai", exact: true });
		const toapis = page.getByRole("radio", { name: "ToAPIs", exact: true });
		const firstFile = page.getByLabel("Reference image 1", { exact: true });
		const secondFile = page.getByLabel("Reference image 2", { exact: true });
		const preview = page.locator("figure");

		await test.step("load the model with zero, one and two eligible providers", async () => {
			await expect(imageLink).toBeVisible();
			await imageLink.press("Enter");
			await expect(page).toHaveURL(imageUrl);
			await expect(
				page.getByRole("banner").getByText("Image Studio", { exact: true }),
			).toBeVisible();
			await expect(imageLink).toHaveAttribute("aria-current", "page");
			await expect(homeLink).not.toHaveAttribute("aria-current", "page");
			await expect(model.locator('optgroup[label="ByteDance / Seedream"] option')).toHaveText([
				"Seedream 5.5",
			]);
			await expect(providers).toHaveCount(0);
			await prompt.fill("tiny");
			expect(fixtures.requests).toEqual([]);
			await page.getByRole("link", { name: "Open Settings" }).press("Enter");
			await saveKey(page, keys.poyo);
			await page.getByRole("link", { name: "ToAPIs", exact: true }).press("Enter");
			await saveKey(page, keys.restricted);
			await expect(page.getByText("Seedream 5.5 access unavailable.")).toBeVisible();

			await imageLink.press("Enter");
			await expect(prompt).toHaveValue("tiny");
			await expect(prompt).toHaveAttribute("aria-invalid", "true");
			await prompt.fill(promptText);
			await expect(providers).toHaveCount(1);
			await expect(poyo).toBeChecked();
			await expect(toapis).toHaveCount(0);

			await settingsLink.press("Enter");
			await page.getByRole("link", { name: "ToAPIs", exact: true }).press("Enter");
			await saveKey(page, keys.toapis, "Replace key");
			await imageLink.press("Enter");
			await expect(providers).toHaveCount(2);
			await expect(poyo).toBeChecked();
			expect(fixtures.requests.map(({ method, path }) => [method, path])).toEqual([
				["GET", "/poyo/balance"],
				["GET", "/toapis/models"],
				["GET", "/toapis/models"],
			]);
		});
		const providerChecks = fixtures.requests.length;

		await test.step("stage mixed references and retain the draft across Settings navigation", async () => {
			await operation.selectOption("edit");
			await expect(page.getByRole("button", { name: "Follow references" })).toHaveAttribute(
				"aria-pressed",
				"true",
			);
			await firstFile.setInputFiles(referenceImage);
			const localPreview = preview.getByRole("img", { name: "Reference image 1" });
			await expect(localPreview).toHaveAttribute("src", /^blob:/);
			await expect
				.poll(() => localPreview.evaluate((image) => (image as HTMLImageElement).naturalWidth))
				.toBe(1);

			await page.getByText("Use a URL", { exact: true }).nth(1).click();
			const source = page.getByRole("textbox", { name: "HTTP or HTTPS URL for reference image 2" });
			await source.fill(referenceUrl);
			await source.press("Enter");
			await expect(secondFile).toBeFocused();
			await expect(firstFile).toHaveAccessibleDescription(/fixture-reference\.png/);
			await expect(
				page.getByText("images.example.test (URL hidden)", { exact: true }),
			).toBeVisible();
			await expect(preview.getByText("Reference image 2")).toBeVisible();
			await expect(preview.getByText("Previews are available for local files.")).toBeVisible();
			await expect(preview.getByRole("img")).toHaveCount(0);

			await settingsLink.press("Enter");
			await expect(settingsLink).toHaveAttribute("aria-current", "page");
			await imageLink.press("Enter");
			await expect(prompt).toHaveValue(promptText);
			await expect(operation).toHaveValue("edit");
			await expect(firstFile).toHaveAccessibleDescription(/fixture-reference\.png/);
			await expect(
				page.getByText("images.example.test (URL hidden)", { exact: true }),
			).toBeVisible();
			await page.getByRole("button", { name: "Preview reference image 1" }).press("Enter");
			await expect(localPreview).toBeVisible();
		});

		await test.step("switch provider by keyboard and discard the draft on reload", async () => {
			await poyo.focus();
			await page.keyboard.press("ArrowRight");
			await expect(toapis).toBeChecked();
			await expect(prompt).toHaveValue(promptText);
			await expect(operation).toHaveValue("edit");
			await expect(secondFile).toHaveCount(0);
			await expect(
				page.getByText("Reference images cleared. Choose them again for this request."),
			).toBeVisible();
			await expect(page.getByRole("group", { name: "Framing presets" })).toBeVisible();
			await expect(page.getByRole("textbox", { name: "Prompt" })).toBeVisible();
			await firstFile.setInputFiles(referenceImage);
			await expect(preview.getByRole("img", { name: "Reference image 1" })).toBeVisible();
			const response = await page.reload();
			if (!response) throw new Error("Image Studio did not return a document.");
			expect(response.headers()["cache-control"]).toBe("no-store");
			const markup = await response.text();
			for (const fixtureValue of [...Object.values(keys), referenceUrl, promptText]) {
				expect(markup).not.toContain(fixtureValue);
			}
			await expect(prompt).toHaveValue("");
			await expect(operation).toHaveValue("generate");
			await expect(poyo).toBeChecked();
			await expect(firstFile).toHaveCount(0);
		});

		await test.step("use mobile navigation and confirm signed-out access and draft reset", async () => {
			await page.setViewportSize({ width: 320, height: 720 });
			await prompt.fill(promptText);
			await operation.selectOption("edit");
			await firstFile.setInputFiles(referenceImage);
			await expect(preview.getByRole("img", { name: "Reference image 1" })).toBeVisible();
			expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
				320,
			);
			const menu = page.getByRole("button", { name: "Menu", exact: true });
			await expect(menu).toBeEnabled();
			await menu.press("Enter");
			await expect(imageLink).toHaveAttribute("aria-current", "page");
			await settingsLink.press("Enter");
			await expect(page.getByRole("dialog")).toHaveCount(0);
			await expect(page.getByRole("banner").getByText("Providers", { exact: true })).toBeVisible();
			await menu.press("Enter");
			await imageLink.press("Enter");
			await expect(page.getByRole("dialog")).toHaveCount(0);
			await expect(prompt).toHaveValue(promptText);
			await expect(firstFile).toHaveAccessibleDescription(/fixture-reference\.png/);
			await menu.press("Enter");
			await homeLink.press("Enter");
			await expect(page).toHaveURL(origin.href);
			await page.getByRole("button", { name: "Sign out" }).press("Enter");
			await expect(page).toHaveURL(signInUrl);

			const signedOut = await page.request.get(imageUrl, { maxRedirects: 0 });
			expect(signedOut.status()).toBe(303);
			expect(signedOut.headers().location).toBe("/sign-in");
			await page.goto(imageUrl);
			await expect(page).toHaveURL(signInUrl);
			await enterOwnerDetails(page, password);
			await page.getByRole("button", { name: "Sign in" }).press("Enter");
			await expect(page).toHaveURL(origin.href);
			await expect(menu).toBeEnabled();
			await menu.press("Enter");
			await imageLink.press("Enter");
			await expect(prompt).toHaveValue("");
			await expect(operation).toHaveValue("generate");
			await expect(firstFile).toHaveCount(0);
		});

		expect(fixtures.requests).toHaveLength(providerChecks);
		expect(outbound).toEqual([]);
		expect(pageErrors).toEqual([]);
		for (const fixtureValue of [...Object.values(keys), referenceUrl, promptText]) {
			expect(server.diagnostics()).not.toContain(fixtureValue);
		}
	} finally {
		await studio?.stop();
		fixtures.stop();
		await rm(directory, { recursive: true, force: true });
	}
});
