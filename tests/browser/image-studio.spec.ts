import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { cmykJpeg, localImageMarker, rotatedJpeg, uprightPng } from "../fixtures/local-image";
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
const referenceUrl = "https://images.example.org/photos/fixture-edit.png?token=fixture-reference";
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
			await page.getByRole("link", { name: "Skip for now" }).click();
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
			await expect(request).toContainText("ToAPIs did not list Seedream 5.5 for this key.");
			await expect(facts).toContainText("Access to this model is unconfirmed.");
			await expect(facts).toContainText("input.enable_safety_checker: false");

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
			await expect(price).toContainText(`Feed collected ${rates.observedAt.slice(0, 10)}`);
			await expect(price).toContainText(
				`Expires ${new Date(rates.toapisExpiry).toISOString().slice(0, 10)}`,
			);
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

		await test.step("accept only the authoritative terms of the current Review", async () => {
			const inspect = review.getByRole("button", { name: "Review request", exact: true });
			const consent = review.getByRole("checkbox", { name: /unknown cost/i });
			const reviews: boolean[] = [];
			const queued: { token: string; acceptUnknown: boolean }[] = [];
			await page.route("**/image/review", (route) => {
				const body = route.request().postDataJSON();
				expect(body.operationKey).toEqual({
					provider: "toapis",
					model: "doubao-seedream-5-5",
					route: "POST /v1/images/generations",
					operation: "text-to-image",
				});
				reviews.push(body.acceptUnknown);
				return route.fulfill({
					json: {
						token: `review-${reviews.length}`,
						quote: { status: "unknown", reason: "missing-feed", maxAttempts: 1 },
						requiresConsent: true,
						acceptUnknown: false,
					},
				});
			});
			await page.route("**/image/queue", (route) => {
				const { token, acceptUnknown } = route.request().postDataJSON();
				queued.push({ token, acceptUnknown });
				return route.fulfill({
					status: 409,
					json: {
						error: "stale",
						review: {
							token: "updated-review",
							quote: { status: "unknown", reason: "expired-feed", maxAttempts: 1 },
							requiresConsent: true,
							acceptUnknown: false,
						},
					},
				});
			});
			await toapis.check();
			await expect(queue(1)).toBeDisabled();
			await expect(inspect).toBeEnabled();
			expect(reviews).toEqual([]);
			await inspect.press("Enter");
			await expect(price).toContainText("No local rate feed is available.");
			await expect(consent).not.toBeChecked();
			await expect(queue(1)).toBeDisabled();
			await consent.check();
			await expect(queue(1)).toBeEnabled();
			await prompt.fill(`${promptText} More light.`);
			await prompt.fill(promptText);
			await expect(queue(1)).toBeDisabled();
			await expect(consent).toHaveCount(0);
			expect(reviews).toEqual([false]);
			await inspect.press("Enter");
			await expect(consent).not.toBeChecked();
			await consent.check();
			await queue(1).press("Enter");
			await expect(review).toContainText("Check the updated Review");
			await expect(price).toContainText("The local rate evidence is 30 days old or older.");
			await expect(queue(1)).toBeDisabled();
			await expect(consent).not.toBeChecked();
			expect(queued).toEqual([{ token: "review-2", acceptUnknown: true }]);
			expect(reviews).toEqual([false, false]);
			await page.unroute("**/image/queue");
			await page.unroute("**/image/review");
			await poyo.check();
		});

		await test.step("review a single URL by keyboard and require the current provider disclosure", async () => {
			await page.setViewportSize({ width: 320, height: 720 });
			await operation.selectOption("edit");
			const inspect = review.getByRole("button", { name: "Review request", exact: true });
			const consent = review.getByRole("checkbox", { name: /unknown cost/i });
			const heading = review.getByRole("heading", { name: "Review request" });
			const disclosure = facts.getByRole("list", { name: "Provider disclosure" });
			const source = request.getByRole("textbox", {
				name: "HTTP or HTTPS URL for reference image 1",
			});
			const firstUrl = "https://images.example.org/photos/a%2Fb.png?sig=first&sig=2#fragment";
			const updatedUrl = firstUrl.replace("sig=first", "sig=updated");
			const originalDisclosure = [
				"Queue sends the prompt and full URL to Poyo.ai, including the path, query and fragment.",
				"Poyo.ai and its upstream model services may process the inputs and fetch the image.",
				"A recipient can keep a copy after the signed link expires.",
			];
			const updatedDisclosure = [
				...originalDisclosure,
				"The task history retains inputs for three months.",
			];
			const terms = {
				quote: { status: "unknown", reason: "missing-feed", maxAttempts: 1 },
				requiresConsent: true,
			};
			const reviewUrls: string[] = [];
			const queueClicks: { token: string; url: string; acceptUnknown: boolean }[] = [];
			await page.route("**/image/review", (route) => {
				const { draft } = route.request().postDataJSON();
				reviewUrls.push(draft.references[0].url);
				const attempt = reviewUrls.length;
				return route.fulfill({
					json: {
						...terms,
						token: `edit-review-${attempt}`,
						...(attempt === 1 ? {} : { editDisclosure: attempt === 2 ? [] : originalDisclosure }),
					},
				});
			});
			await page.route("**/image/queue", (route) => {
				const { draft, token, acceptUnknown } = route.request().postDataJSON();
				queueClicks.push({ token, url: draft.references[0].url, acceptUnknown });
				return route.fulfill({
					status: 409,
					json: {
						error: "stale",
						review: {
							...terms,
							token: "updated-edit-review",
							editDisclosure: queueClicks.length === 1 ? updatedDisclosure : [],
						},
					},
				});
			});

			const stageUrl = async (url: string) => {
				await request.getByText("Use a URL", { exact: true }).first().press("Enter");
				await source.fill(url);
				await source.press("Enter");
				await expect(firstFile).toBeFocused();
			};
			await expect(queue(1)).toHaveAccessibleDescription(/1–10 public image URLs/i);
			await stageUrl(firstUrl);
			await batchTab.press("Enter");
			await review.getByLabel("Batch count").selectOption("2");
			await expect(queue(2)).toHaveAccessibleDescription(/2 potentially billable submissions/);
			await expect(inspect).toBeEnabled();
			await review.getByLabel("Batch count").selectOption("1");
			await review.getByLabel("Additional attempts per request").selectOption("1");
			await expect(queue(1)).toHaveAccessibleDescription(/2 potentially billable submissions/);
			await expect(inspect).toBeEnabled();
			await review.getByLabel("Additional attempts per request").selectOption("0");
			await outgoingTab.press("Enter");
			await expect(outgoing).not.toContainText(/images\.example\.org|a%2Fb|sig=|fragment/);
			await expect(outgoingBody()).toContainText("[remote URL hidden]");
			await expect(inspect).toBeEnabled();
			for (let attempt = 1; attempt <= 2; attempt++) {
				await inspect.press("Enter");
				await expect(queue(1)).toHaveAccessibleDescription(/provider disclosure is unavailable/i);
				await expect(queue(1)).toBeDisabled();
				await expect(consent).toHaveCount(0);
				await expect(inspect).toBeEnabled();
				expect(reviewUrls).toHaveLength(attempt);
			}
			await inspect.press("Enter");
			await expect(heading).toBeFocused();
			await expect(facts).toContainText("images.example.org");
			await expect(disclosure.getByRole("listitem")).toHaveText(originalDisclosure);
			await expect(consent).not.toBeChecked();
			await expect(queue(1)).toBeDisabled();
			await consent.press("Space");
			await expect(queue(1)).toBeEnabled();
			await stageUrl(updatedUrl);
			await expect(disclosure).toHaveCount(0);
			await expect(consent).toHaveCount(0);
			await expect(queue(1)).toBeDisabled();

			await inspect.press("Enter");
			await expect(consent).not.toBeChecked();
			await consent.press("Space");
			await queue(1).press("Enter");
			await expect(heading).toBeFocused();
			await expect(disclosure.getByRole("listitem")).toHaveText(updatedDisclosure);
			await expect(queue(1)).toBeDisabled();
			await expect(consent).not.toBeChecked();
			expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
				320,
			);
			await consent.press("Space");
			await queue(1).press("Enter");
			await expect(queue(1)).toHaveAccessibleDescription(/provider disclosure is unavailable/i);
			await expect(queue(1)).toBeDisabled();
			await expect(disclosure).toHaveCount(0);
			await expect(consent).toHaveCount(0);
			expect(reviewUrls).toEqual([firstUrl, firstUrl, firstUrl, updatedUrl]);
			expect(queueClicks).toEqual([
				{ token: "edit-review-4", url: updatedUrl, acceptUnknown: true },
				{ token: "updated-edit-review", url: updatedUrl, acceptUnknown: true },
			]);

			await page.unroute("**/image/queue");
			await page.unroute("**/image/review");
			await operation.selectOption("generate");
			await page.setViewportSize({ width: 1200, height: 850 });
		});

		await test.step("keep same-host URL identities private while reviewing, moving and replacing slots", async () => {
			await page.setViewportSize({ width: 320, height: 720 });
			await operation.selectOption("edit");
			const firstUrl = "https://images.example.org/a%2Fb.png?sig=handbag-fixture&sig=2#detail";
			const secondUrl = firstUrl.replace("handbag-fixture", "table-fixture");
			const thirdUrl = "https://stock.example.net/room.png?sig=room-fixture";
			const privateName = (label: string) =>
				request.getByRole("textbox", { name: `Private name for reference ${label}`, exact: true });
			const stage = async (slot: number, url: string, label?: string, name?: string) => {
				await request
					.getByText("Use a URL", { exact: true })
					.nth(slot - 1)
					.press("Enter");
				const input = request.getByRole("textbox", {
					name: `HTTP or HTTPS URL for reference image ${slot}`,
				});
				await input.fill(url);
				if (label && name) {
					await privateName(label).fill(name);
					await privateName(label).press("Enter");
				} else {
					if (label) await expect(privateName(label)).toHaveValue("");
					await input.press("Enter");
				}
				await expect(request.getByLabel(`Reference image ${slot}`, { exact: true })).toBeFocused();
			};
			const move = (direction: "up" | "down", slot: number) =>
				request.getByRole("button", { name: `Move ${direction} reference image ${slot}` });
			const inspect = review.getByRole("button", { name: "Review request", exact: true });
			const consent = review.getByRole("checkbox", { name: /unknown cost/i });
			const slots = facts.getByRole("listitem");
			const reviews: { draft: { references: object[] }; acceptUnknown: boolean }[] = [];
			const queues: unknown[] = [];
			await page.route("**/image/review", (route) => {
				reviews.push(route.request().postDataJSON());
				return route.fulfill({
					json: {
						token: "multi-reference-review",
						quote: { status: "unknown", reason: "missing-feed", maxAttempts: 1 },
						requiresConsent: true,
						editDisclosure: ["Queue sends every full URL to Poyo.ai."],
					},
				});
			});
			await page.route("**/image/queue", (route) => {
				queues.push(route.request().postDataJSON());
				return route.fulfill({ status: 409, json: { error: "stale" } });
			});

			await stage(1, firstUrl, "A", "handbag-private");
			await stage(2, secondUrl, "B", "table-private");
			await stage(3, thirdUrl, "C", "room-private");
			await expect(move("up", 1)).toBeDisabled();
			await expect(move("down", 3)).toBeDisabled();
			await move("up", 2).press("Enter");
			await expect(move("down", 1)).toBeFocused();
			await expect(move("down", 1)).toHaveCSS("min-height", "44px");
			expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
				320,
			);
			await expect(
				request.getByRole("status").filter({ hasText: "Reference B moved to position 1 of 3." }),
			).toBeVisible();
			await request.getByRole("button", { name: "Remove reference image 3" }).press("Enter");
			await expect(privateName("C")).toHaveCount(0);
			await expect(prompt).toHaveValue(promptText);
			const movedReference = "1. Reference B · images.example.org (URL reference)";
			const reordered = [movedReference, "2. Reference A · images.example.org (URL reference)"];
			await expect(slots).toHaveText(reordered);
			for (const area of [request, facts]) {
				await expect(area).toContainText(/“image 1” and “image 2”/);
				await expect(area).toContainText(/fixed aspect ratio/);
			}
			await request.getByRole("button", { name: "1:1", exact: true }).press("Enter");
			for (const area of [request, facts])
				await expect(area).not.toContainText(/fixed aspect ratio/);
			await request.getByRole("button", { name: "Follow references", exact: true }).press("Enter");
			await expect(price).toContainText("Estimated 10.2 Poyo.ai credits per request");
			await outgoingTab.press("Enter");
			expect(JSON.parse((await outgoingBody().textContent()) ?? "").input.image_urls).toEqual([
				"[remote URL hidden]",
				"[remote URL hidden]",
			]);
			await expect(outgoing).not.toContainText(/images\.example\.org|sig=|private|Reference [AB]/);
			await inspect.press("Enter");
			await consent.press("Space");
			await privateName("B").fill("table-renamed-private");
			await expect(queue(1)).toBeEnabled();
			await expect(consent).toBeChecked();
			await expect(facts).not.toContainText("table-renamed-private");
			await queue(1).press("Enter");
			await expect(queue(1)).toBeDisabled();
			expect(reviews).toHaveLength(1);
			expect(reviews[0]?.draft.references).toEqual([
				{ kind: "url", url: secondUrl, hostname: "images.example.org" },
				{ kind: "url", url: firstUrl, hostname: "images.example.org" },
			]);
			expect(queues).toEqual([
				{ ...reviews[0], token: "multi-reference-review", acceptUnknown: true },
			]);
			expect(JSON.stringify(reviews)).not.toMatch(/private|Reference [AB]/);
			await inspect.press("Enter");
			await consent.press("Space");
			await move("down", 1).press("Enter");
			await expect(move("up", 2)).toBeFocused();
			await expect(queue(1)).toBeDisabled();
			await expect(consent).toHaveCount(0);
			await move("up", 2).press("Enter");
			await expect(slots).toHaveText(reordered);

			await page.setViewportSize({ width: 1200, height: 850 });
			await settingsLink.press("Enter");
			await expect(settingsLink).toHaveAttribute("aria-current", "page");
			await imageLink.press("Enter");
			await expect(slots).toHaveText(reordered);
			await expect(privateName("A")).toHaveValue("handbag-private");
			await expect(privateName("B")).toHaveValue("table-renamed-private");
			await stage(2, `  ${secondUrl}  `, "E");
			await expect(privateName("A")).toHaveCount(0);
			await expect(privateName("E")).toHaveValue("");
			await expect(slots).toHaveText([
				movedReference,
				"2. Reference E · images.example.org (URL reference)",
			]);
			for (const area of [request, review]) {
				await expect(area).toContainText("Reference images 1 and 2 use the same URL.");
				await expect(area).not.toContainText("table-fixture");
			}
			await expect(inspect).toHaveCount(0);
			await expect(queue(1)).toBeDisabled();
			await stage(3, thirdUrl);
			await move("up", 3).press("Enter");
			for (const area of [request, review]) {
				await expect(area).toContainText("Reference images 1 and 3 use the same URL.");
			}
			await expect(inspect).toHaveCount(0);
			await expect(queue(1)).toBeDisabled();
			await page.unroute("**/image/queue");
			await page.unroute("**/image/review");
			await operation.selectOption("generate");
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
			await expect(queue(1)).toHaveAccessibleDescription(/1–10 public image URLs/i);
			await expect(review.getByRole("button", { name: "Review request", exact: true })).toHaveCount(
				0,
			);

			await stageRemote();
			await expect(secondFile).toBeFocused();
			await expect(firstFile).toHaveAccessibleDescription(/fixture-reference\.png/);
			await expect(
				request.getByText("images.example.org (URL hidden)", { exact: true }),
			).toBeVisible();
			await expect(preview.getByText("Reference image 2")).toBeVisible();
			await expect(preview.getByText("Previews are available for local files.")).toBeVisible();
			await expect(preview.getByRole("img")).toHaveCount(0);
			await expect(queue(1)).toHaveAccessibleDescription(/1–10 public image URLs/i);

			await settingsLink.press("Enter");
			await expect(settingsLink).toHaveAttribute("aria-current", "page");
			await imageLink.press("Enter");
			await expect(prompt).toHaveValue(promptText);
			await expect(operation).toHaveValue("edit");
			await expect(firstFile).toHaveAccessibleDescription(/fixture-reference\.png/);
			await expect(
				request.getByText("images.example.org (URL hidden)", { exact: true }),
			).toBeVisible();
			await page.getByRole("button", { name: "Preview reference image 1" }).press("Enter");
			await expect(localPreview).toBeVisible();
		});

		await test.step("derive the edited wire body and estimates from one validated request", async () => {
			const promptWithUrl = `${promptText} See <${signedPromptUrl}>.`;
			await prompt.fill(promptWithUrl);
			await expect(facts.getByRole("listitem")).toHaveText([
				`1. Reference A · ${referenceImage.name} (local file)`,
				"2. Reference B · images.example.org (URL reference)",
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
				/images\.example\.org|prompt\.example\.test|fixture-reference|fixture-prompt/,
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
				`1. Reference A · ${referenceImage.name} (local file)`,
				"2. Reference B · images.example.org (URL reference)",
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

			const expiry = rates.toapisExpiry;
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
			await test.step("show the selected tab underline in light and dark appearance", async () => {
				const underlineColor = (tab: Locator) =>
					tab.evaluate((element) => getComputedStyle(element).borderBlockEndColor);
				try {
					await page.emulateMedia({ colorScheme: "light" });
					const lightSelected = await underlineColor(outgoingTab);
					expect(lightSelected).not.toBe(await underlineColor(reviewTab));
					await page.emulateMedia({ colorScheme: "dark" });
					const darkSelected = await underlineColor(outgoingTab);
					expect(darkSelected).not.toBe(await underlineColor(reviewTab));
					expect(darkSelected).not.toBe(lightSelected);
				} finally {
					await page.emulateMedia({ colorScheme: null });
				}
			});
			await prompt.fill(promptText.repeat(20));
			const jsonRegion = outgoing.getByRole("region", { name: "JSON request body" });
			await jsonRegion.focus();
			await page.keyboard.press("PageDown");
			await expect.poll(() => jsonRegion.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
			await prompt.fill("bad");
			await expect(outgoingBody()).toHaveCount(0);
			await expect(queue(1)).toBeDisabled();
			await reviewTab.click();
			await expect(price).toContainText("Complete the request to see an estimate.");
			await prompt.fill(promptText);
			await outgoingTab.click();
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
			const openMenu = async () => {
				await menu.press("Enter");
				await expect(
					page.getByRole("dialog").getByRole("button", { name: "Close menu" }),
				).toBeFocused();
			};
			await expect(menu).toBeEnabled();
			await openMenu();
			await expect(imageLink).toHaveAttribute("aria-current", "page");
			await settingsLink.press("Enter");
			await expect(page.getByRole("dialog")).toHaveCount(0);
			await expect(page.getByRole("banner").getByText("Providers", { exact: true })).toBeVisible();
			await openMenu();
			await imageLink.press("Enter");
			await expect(page.getByRole("dialog")).toHaveCount(0);
			await expect(prompt).toHaveValue(promptText);
			await expect(firstFile).toHaveAccessibleDescription(/fixture-reference\.png/);
			await openMenu();
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
			await openMenu();
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

test("built Review prepares and previews one cleaned local copy while Queue stays URL-only", async ({
	context,
	page,
}) => {
	test.setTimeout(90_000);
	page.setDefaultTimeout(10_000);
	const { TOTP } = await import("otpauth");
	const directory = await createOwnerDirectory();
	const fixtures = startProviderFixtures();
	let studio: Awaited<ReturnType<typeof startStudio>> | undefined;
	try {
		const server = await startStudio(directory, "0", false, fixtures.env);
		studio = server;
		const { origin } = server;
		const password = randomUUID();
		const outbound: string[] = [];
		const pageErrors: Error[] = [];
		page.on("pageerror", (error) => pageErrors.push(error));
		await context.route("**/*", (route) => {
			const url = new URL(route.request().url());
			if (url.origin === origin.origin) return route.continue();
			outbound.push(url.origin);
			return route.abort();
		});
		await expect.poll(server.token).not.toBe("");
		await page.goto(new URL("/setup", origin).href);
		await page.getByLabel("Claim token").fill(server.token());
		await enterOwnerDetails(page, password);
		await page.getByRole("button", { name: "Claim studio" }).press("Enter");
		await page.getByRole("link", { name: "Skip for now" }).click();
		await expect(page).toHaveURL(origin.href);

		const files = (draft: string) => new URL(`/image/files/${draft}`, origin).href;
		const stage = (draft: string, data: Buffer, headers: Record<string, string> = {}) =>
			page.request.post(files(draft), {
				headers: {
					origin: origin.origin,
					"content-type": "application/octet-stream",
					...headers,
				},
				data,
			});

		await test.step("no provider connected: the route stages and serves a private copy", async () => {
			const png = await uprightPng();
			const draft = randomUUID();
			const staged = await stage(draft, png);
			expect(staged.status()).toBe(200);
			const descriptor = await staged.json();
			expect(Object.keys(descriptor).sort()).toEqual([
				"deadline",
				"digest",
				"draft",
				"handle",
				"mime",
				"size",
				"transform",
			]);
			expect(descriptor).toMatchObject({ mime: "image/png", transform: "none", draft });
			const media = await page.request.get(`${files(draft)}/${descriptor.handle}`);
			expect(media.status()).toBe(200);
			expect(media.headers()).toMatchObject({
				"content-type": "image/png",
				"cache-control": "private, no-store",
				"x-content-type-options": "nosniff",
				"cross-origin-resource-policy": "same-origin",
			});
			expect(Buffer.from(await media.body()).equals(png)).toBe(true);
			expect(
				(
					await page.request.get(`${files(draft)}/${descriptor.handle}`, {
						headers: { "sec-fetch-site": "cross-site" },
					})
				).status(),
			).toBe(403);
			expect((await stage(randomUUID(), png, { origin: "null" })).status()).toBe(403);
			expect((await stage("not-a-draft", png)).status()).toBe(400);
			expect(fixtures.requests).toEqual([]);
			await page.request.post(`${files(draft)}/${descriptor.handle}`, {
				headers: { origin: origin.origin },
			});
			expect((await page.request.get(`${files(draft)}/${descriptor.handle}`)).status()).toBe(404);
		});

		await page.goto(new URL("/settings/providers", origin).href);
		await saveKey(page, keys.poyo);
		const providerChecks = fixtures.requests.length;
		await page.goto(new URL("/image", origin).href);
		const operation = page.getByLabel("Operation", { exact: true });
		const firstFile = page.getByLabel("Reference image 1", { exact: true });
		const review = page.getByRole("region", { name: "Review request", exact: true });
		const facts = review.getByRole("tabpanel", { name: "Review", exact: true });
		const localCopy = facts.getByRole("region", { name: "Local copy", exact: true });
		const prepare = localCopy.getByRole("button", { name: /^Prepar/ });
		const status = localCopy.getByRole("status");
		const cleaned = localCopy.getByRole("img", { name: "Cleaned local copy" });
		const queue = review.getByRole("button", { name: "Queue 1 request" });
		await page.getByRole("textbox", { name: "Prompt", exact: true }).fill(promptText);
		await operation.selectOption("edit");

		let first = "";
		await test.step("Prepare local copy → progress, preview, cleaned size, survival notes, Queue disabled", async () => {
			await firstFile.setInputFiles({
				name: "sideways-photo.jpg",
				mimeType: "image/jpeg",
				buffer: await rotatedJpeg(),
			});
			await expect(prepare).toHaveText("Prepare local copy");
			await expect(queue).toBeDisabled();
			await expect(queue).toHaveAccessibleDescription(/1–10 public image URLs/i);
			const hold = Promise.withResolvers<void>();
			await page.route("**/image/files/*", async (route) => {
				await hold.promise;
				await route.continue();
			});
			await prepare.press("Enter");
			await expect(prepare).toHaveText("Preparing local copy…");
			await expect(prepare).toBeDisabled();
			await expect(status).toHaveText("Cleaning and verifying the file…");
			hold.resolve();
			await expect(status).toHaveText("Cleaned copy ready.");
			await page.unroute("**/image/files/*");
			await expect(cleaned).toHaveAttribute(
				"src",
				/^\/image\/files\/[0-9a-f-]{36}\/[0-9a-f-]{36}$/,
			);
			first = (await cleaned.getAttribute("src")) ?? "";
			await expect
				.poll(() =>
					cleaned.evaluate((image) => [
						(image as HTMLImageElement).naturalWidth,
						(image as HTMLImageElement).naturalHeight,
					]),
				)
				.toEqual([32, 48]);
			await expect(localCopy).toContainText(/JPEG · [\d.]+ KB \([\d,]+ bytes\)/);
			await expect(localCopy).toContainText("Re-encoded to apply rotation.");
			await expect(localCopy).toContainText("Watermarks in the picture itself survive.");
			await expect(localCopy).toContainText("Its creator, copyright, creation date");
			await expect(queue).toBeDisabled();
			await expect(queue).toHaveAccessibleDescription(/1–10 public image URLs/i);
			const served = await page.request.get(new URL(first, origin).href);
			expect(served.headers()["content-type"]).toBe("image/jpeg");
			const bytes = Buffer.from(await served.body());
			expect(bytes.includes(Buffer.from(localImageMarker))).toBe(false);
			await expect(localCopy).toContainText(`(${bytes.length.toLocaleString("en-US")} bytes)`);
			// The preview stays inside the Review panel.
			const [imageBox, panelBox] = await Promise.all([cleaned.boundingBox(), facts.boundingBox()]);
			expect(imageBox && panelBox && imageBox.width <= panelBox.width).toBe(true);
		});

		await test.step("replacement 404s the old preview", async () => {
			await firstFile.setInputFiles({
				name: "upright.png",
				mimeType: "image/png",
				buffer: await uprightPng(),
			});
			await expect(cleaned).toHaveCount(0);
			await expect(prepare).toHaveText("Prepare local copy");
			await expect
				.poll(async () => (await page.request.get(new URL(first, origin).href)).status())
				.toBe(404);
			await prepare.press("Enter");
			await expect(status).toHaveText("Cleaned copy ready.");
			await expect(localCopy).toContainText(/PNG · /);
			await expect(localCopy).not.toContainText("Re-encoded to apply rotation");
			await expect(prepare).toHaveText("Prepare again");
			const previous = (await cleaned.getAttribute("src")) ?? "";
			await prepare.press("Enter");
			await expect(status).toHaveText("Cleaned copy ready.");
			expect(await cleaned.getAttribute("src")).not.toBe(previous);
			expect((await page.request.get(new URL(previous, origin).href)).status()).toBe(404);
		});

		await test.step("CMYK refusal, no preview", async () => {
			await firstFile.setInputFiles({
				name: "print.jpg",
				mimeType: "image/jpeg",
				buffer: await cmykJpeg(),
			});
			await prepare.press("Enter");
			await expect(status).toHaveText(
				"The JPEG uses unsupported image coding. Export a single-frame SDR JPEG or PNG.",
			);
			await expect(cleaned).toHaveCount(0);
			await expect(queue).toBeDisabled();
		});

		await test.step("other-tab security change clears it", async () => {
			await firstFile.setInputFiles({
				name: "upright.png",
				mimeType: "image/png",
				buffer: await uprightPng(),
			});
			await prepare.press("Enter");
			await expect(status).toHaveText("Cleaned copy ready.");
			const src = (await cleaned.getAttribute("src")) ?? "";
			const security = await context.newPage();
			try {
				await security.goto(new URL("/settings/security", origin).href);
				await security.getByLabel("Current password").fill(password);
				await security.getByRole("button", { name: "Set up authenticator" }).click();
				const seed = await security.locator("section code").first().textContent();
				if (!seed) throw new Error("Missing manual setup.");
				await security
					.getByLabel("New authenticator code")
					.fill(new TOTP({ secret: seed }).generate());
				await security.getByRole("button", { name: "Confirm authenticator" }).click();
				await expect(security.locator("section li")).toHaveCount(10);
			} finally {
				await security.close();
			}
			await expect(cleaned).toHaveCount(0);
			await expect(page.getByRole("textbox", { name: "Prompt", exact: true })).toHaveValue("");
			expect((await page.request.get(new URL(src, origin).href)).status()).toBe(404);
		});

		expect(fixtures.requests).toHaveLength(providerChecks);
		expect(outbound).toEqual([]);
		expect(pageErrors).toEqual([]);
		for (const value of [localImageMarker, "sideways-photo.jpg", "upright.png", "print.jpg"])
			expect(server.diagnostics()).not.toContain(value);
	} finally {
		await studio?.stop();
		fixtures.stop();
		await rm(directory, { recursive: true, force: true });
	}
});
