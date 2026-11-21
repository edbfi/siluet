import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { test as base, expect } from "@playwright/test";
import { createOwnerDirectory } from "../fixtures/owner-directory";
import { providerFixtureKeys, startProviderFixtures } from "../fixtures/provider-connections";
import { referencePng } from "../fixtures/reference-image";
import { startStudio } from "./built-studio";

const image = {
	name: "private-reference.png",
	mimeType: "image/png",
	buffer: referencePng,
};
const truncated = {
	...image,
	name: "truncated.png",
	buffer: image.buffer.subarray(0, 33),
};
const username = "draft-owner";
const privatePrompt = "Private draft of the composition in the second studio tab.";

const test = base.extend<{ studio: { origin: URL; password: string } }>({
	studio: async ({ page }, use) => {
		const directory = await createOwnerDirectory();
		const providers = startProviderFixtures();
		let server: Awaited<ReturnType<typeof startStudio>> | undefined;
		try {
			server = await startStudio(directory, "0", false, providers.env);
			const { origin, token } = server;
			const password = randomUUID();
			await expect.poll(token).not.toBe("");
			await page.goto(new URL("/setup", origin).href);
			await page.getByLabel("Claim token").fill(token());
			await page.getByLabel("Username", { exact: true }).fill(username);
			await page.getByLabel("Password", { exact: true }).fill(password);
			await page.getByRole("button", { name: "Claim studio" }).click();
			await expect(page).toHaveURL(origin.href);

			await page.goto(new URL("/settings/providers", origin).href);
			await page.getByLabel("API key").fill(providerFixtureKeys.poyo);
			await page.getByRole("button", { name: "Connect", exact: true }).click();
			await expect(page.getByRole("status")).toHaveText("Key accepted and saved.");
			await page.goto(new URL("/image", origin).href);
			await use({ origin, password });
			expect(providers.requests).toEqual([
				{ method: "GET", path: "/poyo/balance", key: providerFixtureKeys.poyo },
			]);
		} finally {
			await server?.stop();
			providers.stop();
			await rm(directory, { recursive: true, force: true });
		}
	},
});

test("a truncated local image cannot become a reference or replace a decoded image", async ({
	page,
	studio,
}) => {
	await expect(page).toHaveURL(new URL("/image", studio.origin).href);
	await page.getByLabel("Operation", { exact: true }).selectOption("edit");
	const first = page.getByLabel("Reference image 1", { exact: true });
	const second = page.getByLabel("Reference image 2", { exact: true });
	const preview = page.getByRole("img", { name: "Reference image 1", exact: true });
	const decodeError = page.getByText("Could not decode this image. Choose a complete image file.");

	await first.setInputFiles(truncated);
	await expect(decodeError).toBeVisible();
	await expect(second).toHaveCount(0);
	await expect(preview).toHaveCount(0);

	await first.setInputFiles(image);
	await expect(preview).toHaveAttribute("src", /^blob:/);
	await expect(first).toHaveAccessibleDescription(/private-reference\.png/);
	const originalPreview = await preview.getAttribute("src");

	await first.setInputFiles(truncated);
	await expect(decodeError).toBeVisible();
	await expect(first).toHaveAccessibleDescription(/private-reference\.png/);
	await expect(preview).toHaveAttribute("src", originalPreview ?? "");
	await expect(second).toBeVisible();
});

for (const cookieEvents of [true, false]) {
	test(`a successful plain POST sign-out clears another tab's draft ${cookieEvents ? "with scripts blocked in the submitter" : "through the browser fallback"}`, async ({
		context,
		page,
		studio,
	}) => {
		const { origin, password } = studio;
		if (!cookieEvents) {
			await context.addInitScript(() => {
				Object.defineProperty(globalThis, "cookieStore", { value: undefined });
			});
			await page.reload();
		}
		const signIn = new URL("/sign-in", origin).href;
		const prompt = page.getByRole("textbox", { name: "Prompt", exact: true });
		await prompt.fill(privatePrompt);
		await page.getByLabel("Operation", { exact: true }).selectOption("edit");
		await page.getByLabel("Reference image 1", { exact: true }).setInputFiles(image);
		const localPreview = page.getByRole("img", { name: "Reference image 1", exact: true });
		await expect(localPreview).toHaveAttribute("src", /^blob:/);
		await expect(prompt).toHaveValue(privatePrompt);

		const otherTab = await context.newPage();
		try {
			await otherTab.route("**/*", (route) =>
				route.request().resourceType() === "script" ? route.abort() : route.fallback(),
			);
			await otherTab.goto(origin.href);
			const form = otherTab.locator('form[action="?/signout"]');
			await expect(form).toHaveAttribute("method", "POST");
			await otherTab.route("**/?/signout", (route) =>
				route.fulfill({ status: 503, body: "Fixture rejected the sign-out request" }),
			);
			await form.evaluate((element: HTMLFormElement) => element.submit());
			await expect(otherTab.getByText("Fixture rejected the sign-out request")).toBeVisible();
			await expect(prompt).toHaveValue(privatePrompt);
			await expect(localPreview).toBeVisible();
			await otherTab.unroute("**/?/signout");

			await otherTab.goto(origin.href);
			await form.evaluate((element: HTMLFormElement) => element.submit());
			await expect(otherTab).toHaveURL(signIn);
			await expect(page).toHaveURL(signIn);
			await expect(prompt).toHaveCount(0);
			await expect(localPreview).toHaveCount(0);

			const { cookies, origins } = await context.storageState();
			const storage = JSON.stringify({
				cookies: cookies.filter((cookie) => !cookie.httpOnly),
				origins,
			});
			expect(storage).not.toContain(privatePrompt);
			expect(storage).not.toContain(image.name);
			await page.getByLabel("Username", { exact: true }).fill(username);
			await page.getByLabel("Password", { exact: true }).fill(password);
			await page.getByRole("button", { name: "Sign in" }).click();
			await expect(page).toHaveURL(origin.href);
			await page.getByRole("link", { name: "Image Studio", exact: true }).click();
			await expect(prompt).toHaveValue("");
			await expect(localPreview).toHaveCount(0);
		} finally {
			await otherTab.close();
		}
	});
}
