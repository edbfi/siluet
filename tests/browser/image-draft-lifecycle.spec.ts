import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { expect } from "@playwright/test";
import { createOwnerDirectory } from "../fixtures/owner-directory";
import { providerFixtureKeys, startProviderFixtures } from "../fixtures/provider-connections";
import { referencePng } from "../fixtures/reference-image";
import { startStudio } from "./built-studio";
import { test as base } from "./studio-test";

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
			await page.getByRole("link", { name: "Skip for now" }).click();
			await page.getByRole("button", { name: "Continue to studio" }).click();
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

for (const channel of [true, false]) {
	test(`sign-out in another tab clears this tab's draft ${channel ? "over the broadcast channel" : "through the storage fallback"}`, async ({
		context,
		page,
		studio,
	}) => {
		const { origin, password } = studio;
		if (!channel) {
			await context.addInitScript(() => {
				Object.defineProperty(globalThis, "BroadcastChannel", { value: undefined });
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
			await otherTab.goto(origin.href);
			const signOut = otherTab.getByRole("button", { name: "Sign out" });
			// A failed sign-out keeps the session and every draft, and offers Retry.
			await otherTab.route("**/owner/sign-out", (route) =>
				route.fulfill({ status: 503, body: "Fixture rejected the sign-out request" }),
			);
			await signOut.click();
			await expect(otherTab.getByRole("alert")).toHaveText("Sign-out did not finish. Retry.");
			await expect(prompt).toHaveValue(privatePrompt);
			await expect(localPreview).toBeVisible();
			await otherTab.unroute("**/owner/sign-out");

			await signOut.click();
			await expect(otherTab).toHaveURL(signIn);
			await expect(page).toHaveURL(signIn);
			await expect(prompt).toHaveCount(0);
			await expect(localPreview).toHaveCount(0);

			const { cookies, origins } = await context.storageState();
			expect(cookies).toEqual([]);
			const storage = JSON.stringify(origins);
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

test("a tab that missed the notices drops its old draft once another tab signs back in", async ({
	context,
	page,
	studio,
}) => {
	const { origin, password } = studio;
	const signIn = new URL("/sign-in", origin).href;
	const imageStudio = new URL("/image", origin).href;
	// This tab hears no notices, as if it was suspended while the others changed session.
	await page.addInitScript(() => {
		Object.defineProperty(globalThis, "BroadcastChannel", { value: undefined });
		addEventListener("storage", (event) => event.stopImmediatePropagation(), { capture: true });
	});
	await page.reload();
	const prompt = page.getByRole("textbox", { name: "Prompt", exact: true });
	await prompt.fill(privatePrompt);
	await page.getByLabel("Operation", { exact: true }).selectOption("edit");
	await page.getByLabel("Reference image 1", { exact: true }).setInputFiles(image);
	const preview = page.getByRole("img", { name: "Reference image 1", exact: true });
	await expect(preview).toHaveAttribute("src", /^blob:/);

	const otherTab = await context.newPage();
	const staged: string[] = [];
	try {
		await otherTab.goto(origin.href);
		await otherTab.getByRole("button", { name: "Sign out" }).click();
		await expect(otherTab).toHaveURL(signIn);
		await otherTab.getByLabel("Username", { exact: true }).fill(username);
		await otherTab.getByLabel("Password", { exact: true }).fill(password);
		await otherTab.getByRole("button", { name: "Sign in" }).click();
		await expect(otherTab).toHaveURL(origin.href);
		await expect(prompt).toHaveValue(privatePrompt);
		await expect(preview).toBeVisible();

		// After the new sign-in, no request of the old draft goes out under the new session.
		page.on("request", (request) => {
			if (request.url().includes("/image/files/")) staged.push(request.method());
		});
		const reloaded = page.waitForEvent("load");
		await page.evaluate(() => window.dispatchEvent(new Event("focus")));
		await reloaded;
		await expect(page).toHaveURL(imageStudio);
		await expect(prompt).toHaveValue("");
		await expect(preview).toHaveCount(0);
		expect(staged).toEqual([]);
		await page.goto(signIn);
		await expect(page).toHaveURL(origin.href);
	} finally {
		await otherTab.close();
	}
});

test("a Security change reloads sibling tabs, and a delayed stale request leaves the new session and issued codes readable", async ({
	context,
	page,
	studio,
}) => {
	test.setTimeout(60000);
	const { TOTP } = await import("otpauth");
	const { origin, password } = studio;
	const draft = page.getByRole("textbox", { name: "Prompt", exact: true });
	await draft.fill(privatePrompt);
	const video = await context.newPage();
	const security = await context.newPage();
	const observer = await context.newPage();
	const started = Promise.withResolvers<void>(),
		deliver = Promise.withResolvers<void>();
	try {
		await video.goto(new URL("/video", origin).href);
		const videoPrompt = video.getByRole("textbox", { name: "Prompt", exact: true });
		await videoPrompt.fill("A private reviewed video draft.");
		await video.getByRole("button", { name: "Review request" }).click();
		const consent = video.getByRole("checkbox", { name: /I accept/ });
		await consent.check();
		await expect(consent).toBeChecked();
		await security.goto(new URL("/settings/security", origin).href);
		await security.getByLabel("Current password").fill(password);
		await security.getByRole("button", { name: "Set up authenticator" }).click();
		const seed = await security.locator("section code").first().textContent();
		if (!seed) throw new Error("Missing manual setup.");
		await security.getByLabel("New authenticator code").fill(new TOTP({ secret: seed }).generate());
		// A request sent with the old bearer arrives after the rotation.
		await observer.goto(new URL("/jobs", origin).href);
		await observer.route("**/settings/files/state", async (route) => {
			started.resolve();
			await deliver.promise;
			await route.continue();
		});
		const delayed = observer
			.evaluate(async () => (await fetch("/settings/files/state")).status)
			.catch(() => "reloaded");
		await started.promise;
		await security.getByRole("button", { name: "Confirm authenticator" }).click();
		const codes = security.getByRole("dialog").locator("li");
		await expect(codes).toHaveCount(10);
		const before = await codes.allTextContents();
		deliver.resolve();
		expect(await delayed).not.toBe(200);
		await expect(draft).toHaveValue("");
		await expect(videoPrompt).toHaveValue("");
		await expect(consent).toHaveCount(0);
		await expect(video.getByRole("button", { name: "Queue 1 request" })).toHaveCount(0);
		// Every tab ends on the successor session.
		await expect(observer.getByRole("heading", { name: "No jobs yet" })).toBeVisible();
		expect(JSON.stringify(await codes.allTextContents()) === JSON.stringify(before)).toBe(true);
		await security.getByRole("dialog").getByRole("button", { name: "Done" }).click();
		await expect(codes).toHaveCount(0);
		await security.goBack();
		expect((await security.locator("body").textContent())?.includes(before[0])).toBe(false);
	} finally {
		deliver.resolve();
		await observer.close();
		await security.close();
		await video.close();
	}
});
