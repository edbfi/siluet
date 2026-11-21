import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { createOwnerDirectory } from "../fixtures/owner-directory";
import {
	providerFixtureKeys as keys,
	startProviderFixtures,
} from "../fixtures/provider-connections";
import { referenceGif, referencePng, truncatedReferenceGif } from "../fixtures/reference-image";
import { writeReviewPricing } from "../fixtures/review-pricing";
import { startStudio } from "./built-studio";

const username = "image-owner";
const promptText = "Blend image 1 and image 2 under soft evening light.";
const referenceUrl = "https://images.example.test/photos/fixture-edit.png?token=fixture-reference";
const signedPromptUrl = "https://prompt.example.test/text?token=fixture-prompt";
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
	const cacheHome = await mkdtemp(join(tmpdir(), "siluet-image-pricing-"));
	const fixtures = startProviderFixtures();
	let studio: Awaited<ReturnType<typeof startStudio>> | undefined;
	try {
		const rates = await writeReviewPricing(cacheHome);
		await page.clock.install({ time: new Date(rates.observedMs + 60_000) });
		const server = await startStudio(directory, "0", false, {
			...fixtures.env,
			XDG_CACHE_HOME: cacheHome,
		});
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
		const toapisLink = page.getByRole("link", { name: "ToAPIs", exact: true });
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
		const request = page.getByRole("region", { name: "Request", exact: true });
		const review = page.getByRole("region", { name: "Review request", exact: true });
		const reviewTab = review.getByRole("tab", { name: "Review", exact: true });
		const batchTab = review.getByRole("tab", { name: "Batch", exact: true });
		const outgoingTab = review.getByRole("tab", { name: "Outgoing request", exact: true });
		const facts = review.getByRole("tabpanel", { name: "Review", exact: true });
		const outgoing = review.getByRole("tabpanel", { name: "Outgoing request", exact: true });
		const price = facts.locator("[data-studio-price]");
		const queue = (count: number) =>
			review.getByRole("button", {
				name: `Queue ${count} ${count === 1 ? "request" : "requests"}`,
			});
		const outgoingBody = () => outgoing.locator("pre code");
		const stageRemote = async () => {
			await request.getByText("Use a URL", { exact: true }).nth(1).click();
			const source = request.getByRole("textbox", {
				name: "HTTP or HTTPS URL for reference image 2",
			});
			await source.fill(referenceUrl);
			await source.press("Enter");
		};

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
			await expect(facts).toContainText("None connected");
			await expect(queue(1)).toBeDisabled();
			await expect(queue(1)).toHaveAccessibleDescription(/Up to 1 potentially billable submission/);
			await prompt.fill("tiny");
			expect(fixtures.requests).toEqual([]);
			await page.getByRole("link", { name: "Open Settings" }).press("Enter");
			await saveKey(page, keys.poyo);
			await toapisLink.press("Enter");
			await expect(toapisLink).toHaveAttribute("aria-current", "page");
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
			await toapisLink.press("Enter");
			await expect(toapisLink).toHaveAttribute("aria-current", "page");
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

		await test.step("review one-image generation on both connected providers", async () => {
			await expect(price).toContainText("Estimated 7 Poyo.ai credits per request");
			await expect(price).toContainText(`Rates dated ${rates.observedAt.slice(0, 10)}`);
			await outgoingTab.click();
			await expect(outgoing).toContainText("POST https://api.poyo.ai/api/generate/submit");
			await expect(outgoing).toContainText("Authorization: Bearer [API key hidden]");
			expect(JSON.parse((await outgoingBody().textContent()) ?? "")).toEqual({
				model: "seedream-5.5",
				input: {
					prompt: promptText,
					size: "1:1",
					resolution: "2K",
					background: "auto",
					output_format: "png",
					enable_safety_checker: false,
				},
			});

			await toapis.check();
			await reviewTab.click();
			await expect(price).toContainText("Standard-route pricing");
			await expect(price).toContainText("Estimated 5.6 ToAPIs credits per request");
			await expect(review).toContainText("Fallback pricing is unknown.");
			await outgoingTab.click();
			await expect(outgoing).toContainText("POST https://toapis.com/v1/images/generations");
			expect(JSON.parse((await outgoingBody().textContent()) ?? "")).toEqual({
				model: "doubao-seedream-5-5",
				prompt: promptText,
				size: "2K",
				disable_nsfw: false,
				metadata: { background: "auto", output_format: "png", watermark: false },
			});
			await poyo.check();
			await reviewTab.click();
		});

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

			await stageRemote();
			await expect(secondFile).toBeFocused();
			await expect(firstFile).toHaveAccessibleDescription(/fixture-reference\.png/);
			await expect(
				request.getByText("images.example.test (URL hidden)", { exact: true }),
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
				request.getByText("images.example.test (URL hidden)", { exact: true }),
			).toBeVisible();
			await page.getByRole("button", { name: "Preview reference image 1" }).press("Enter");
			await expect(localPreview).toBeVisible();
		});

		await test.step("derive the edited wire body and estimates from one validated request", async () => {
			const promptWithUrl = `${promptText} See <${signedPromptUrl}>.`;
			await prompt.fill(promptWithUrl);
			await expect(facts.getByRole("listitem")).toHaveText([
				`${referenceImage.name} (file upload)`,
				"images.example.test (provider fetches the full URL)",
			]);
			await expect(price).toContainText("Estimated 10.2 Poyo.ai credits per request");
			await batchTab.click();
			await expect(review.getByLabel("Additional attempts per request")).toHaveValue("0");
			await review.getByLabel("Batch count").selectOption("2");
			await review.getByLabel("Additional attempts per request").selectOption("1");
			await expect(queue(2)).toHaveAccessibleDescription(
				/Up to 4 potentially billable submissions/,
			);
			await reviewTab.click();
			await expect(price).toContainText("Estimated 20.4 Poyo.ai credits for the initial batch");

			await outgoingTab.click();
			await expect(queue(2)).toBeDisabled();
			await expect(outgoing).not.toContainText(
				/images\.example\.test|prompt\.example\.test|fixture-reference|fixture-prompt/,
			);
			expect(JSON.parse((await outgoingBody().textContent()) ?? "")).toEqual({
				model: "seedream-5.5",
				input: {
					prompt: `${promptText} See <[URL hidden]>.`,
					size: "auto",
					resolution: "2K",
					background: "auto",
					output_format: "png",
					enable_safety_checker: false,
					image_urls: ["[local image]", "[remote URL hidden]"],
				},
			});
			await expect(prompt).toHaveValue(promptWithUrl);
			await prompt.fill(promptText);
			await reviewTab.click();
			await expect(facts.getByRole("listitem")).toHaveText([
				`${referenceImage.name} (file upload)`,
				"images.example.test (provider fetches the full URL)",
			]);
		});

		await test.step("switch provider by keyboard, review an edit, and discard the draft on reload", async () => {
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
			await expect(price).toContainText("Complete the request");
			await firstFile.setInputFiles(referenceImage);
			const localPreview = preview.getByRole("img", { name: "Reference image 1" });
			await expect(localPreview).toBeVisible();
			const originalSource = await localPreview.getAttribute("src");

			// The browser decodes the first frame even though the second frame is truncated.
			expect(
				await page.evaluate(
					async (bytes) => {
						const frame = await createImageBitmap(
							new Blob([Uint8Array.from(bytes)], { type: "image/gif" }),
						);
						const width = frame.width;
						frame.close();
						return width;
					},
					[...truncatedReferenceGif],
				),
			).toBe(1);
			await firstFile.setInputFiles({
				name: "truncated.gif",
				mimeType: "image/gif",
				buffer: truncatedReferenceGif,
			});
			await expect(page.getByText("Choose a complete GIF file.")).toBeVisible();
			await expect(firstFile).toHaveAccessibleDescription(/fixture-reference\.png/);
			await expect(localPreview).toHaveAttribute("src", originalSource ?? "");

			await firstFile.setInputFiles({
				name: "complete.gif",
				mimeType: "image/gif",
				buffer: referenceGif,
			});
			await expect(firstFile).toHaveAccessibleDescription(/complete\.gif/);
			await expect(localPreview).not.toHaveAttribute("src", originalSource ?? "");
			await stageRemote();
			await outgoingTab.click();
			expect(JSON.parse((await outgoingBody().textContent()) ?? "")).toEqual({
				model: "doubao-seedream-5-5",
				prompt: promptText,
				size: "2K",
				disable_nsfw: false,
				metadata: { background: "auto", output_format: "png", watermark: false },
				image_urls: ["[local image]", "[remote URL hidden]"],
			});
			await batchTab.click();
			await review.getByLabel("Batch count").selectOption("5");
			await review.getByLabel("Additional attempts per request").selectOption("3");
			await expect(queue(5)).toHaveAccessibleDescription(
				/Up to 20 potentially billable submissions/,
			);
			await reviewTab.click();
			await expect(price).toContainText("Estimated 28 ToAPIs credits for the initial batch");
			await request.getByText("Advanced options", { exact: true }).click();
			await request.getByLabel("Visible watermark").check();
			await expect(price).toContainText("Local rates do not cover these options.");
			await expect(queue(5)).toHaveAccessibleDescription(
				/Up to 20 potentially billable submissions/,
			);
			await request.getByLabel("Visible watermark").uncheck();

			const expiry = rates.observedMs + 30 * 24 * 60 * 60 * 1000;
			await page.clock.pauseAt(new Date(expiry - 1000));
			await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
			await page.clock.runFor(999);
			await expect(price).toContainText("Estimated 28 ToAPIs credits for the initial batch");
			await page.clock.runFor(1);
			await expect(price).toContainText("The local rate evidence is 30 days old or older.");
			await expect(queue(5)).toBeDisabled();
			await expect(queue(5)).toHaveAccessibleDescription(
				/Up to 20 potentially billable submissions/,
			);

			await page.clock.setSystemTime(new Date(expiry - 1000));
			await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
			await expect(price).toContainText("Estimated 28 ToAPIs credits for the initial batch");
			await page.clock.setSystemTime(new Date(expiry));
			await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
			await expect(price).toContainText("The local rate evidence is 30 days old or older.");
			await page.clock.resume();

			const response = await page.reload();
			if (!response) throw new Error("Image Studio did not return a document.");
			expect(response.headers()["cache-control"]).toBe("no-store");
			const markup = await response.text();
			for (const fixtureValue of [
				...Object.values(keys),
				referenceUrl,
				promptText,
				signedPromptUrl,
				referenceImage.name,
			]) {
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
			await page.getByRole("link", { name: "Review request", exact: true }).press("Enter");
			await expect(review.getByRole("heading", { name: "Review request" })).toBeFocused();
			await page.keyboard.press("Tab");
			await expect(reviewTab).toBeFocused();
			await page.keyboard.press("ArrowLeft");
			await expect(outgoingTab).toBeFocused();
			await expect(outgoingTab).toHaveAttribute("aria-selected", "true");
			await page.keyboard.press("ArrowRight");
			await expect(reviewTab).toBeFocused();
			await page.keyboard.press("ArrowRight");
			await expect(batchTab).toBeFocused();
			await page.keyboard.press("End");
			await expect(outgoingTab).toBeFocused();
			await page.keyboard.press("Home");
			await expect(reviewTab).toBeFocused();
			await expect(review.locator('[role="tab"][tabindex="0"]')).toHaveCount(1);
			await expect(review.getByRole("tabpanel")).toHaveCount(1);
			await page.keyboard.press("Tab");
			await expect(facts).toBeFocused();
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

		await test.step("clear staged media when the last eligible provider disappears", async () => {
			await page.setViewportSize({ width: 1200, height: 850 });
			await operation.selectOption("edit");
			await firstFile.setInputFiles(referenceImage);
			await expect(preview.getByRole("img", { name: "Reference image 1" })).toBeVisible();
			await settingsLink.press("Enter");
			const poyoLink = page.getByRole("link", { name: "Poyo.ai", exact: true });
			const remove = page.getByRole("button", { name: "Remove key", exact: true });
			await poyoLink.press("Enter");
			await expect(poyoLink).toHaveAttribute("aria-current", "page");
			await remove.press("Enter");
			await expect(page.getByRole("status")).toHaveText("Key removed.");
			await toapisLink.press("Enter");
			await expect(toapisLink).toHaveAttribute("aria-current", "page");
			await remove.press("Enter");
			await expect(page.getByRole("status")).toHaveText("Key removed.");
			await imageLink.press("Enter");
			await expect(providers).toHaveCount(0);
			await expect(firstFile).toHaveCount(0);
			await expect(page.getByText("Reference images cleared.", { exact: true })).toBeVisible();
		});

		expect(fixtures.requests).toHaveLength(providerChecks);
		expect(outbound).toEqual([]);
		expect(pageErrors).toEqual([]);
		for (const fixtureValue of [
			...Object.values(keys),
			referenceUrl,
			promptText,
			signedPromptUrl,
			referenceImage.name,
		]) {
			expect(server.diagnostics()).not.toContain(fixtureValue);
		}
	} finally {
		await studio?.stop();
		fixtures.stop();
		await Promise.all([
			rm(directory, { recursive: true, force: true }),
			rm(cacheHome, { recursive: true, force: true }),
		]);
	}
});
