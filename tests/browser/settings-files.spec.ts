import { randomUUID } from "node:crypto";
import { chmod, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { type Browser, expect, type Page, test } from "@playwright/test";
import { TOTP } from "otpauth";
import { uprightPng } from "../fixtures/local-image";
import { createOwnerDirectory } from "../fixtures/owner-directory";
import { startStudio } from "./built-studio";

type Studio = Awaited<ReturnType<typeof startStudio>>;

async function withStudio(run: (studio: Studio, directory: string) => Promise<void>) {
	const directory = await createOwnerDirectory();
	const studio = await startStudio(directory, "0", false);
	try {
		await run(studio, directory);
	} finally {
		await studio.stop();
		await rm(directory, { recursive: true, force: true });
	}
}

async function claim(page: Page, studio: Studio, password = randomUUID()) {
	await expect.poll(studio.token).not.toBe("");
	await page.goto(new URL("/setup", studio.origin).href);
	await page.getByLabel("Claim token").fill(studio.token());
	await page.getByLabel("Username").fill("owner");
	await page.getByLabel("Password", { exact: true }).fill(password);
	await page.getByRole("button", { name: "Claim studio" }).click();
	await expect(page).toHaveURL(/\/settings\/security\?offer$/);
	return password;
}

const cleaningSwitch = (page: Page) =>
	page.getByRole("switch", { name: "Remove metadata before upload" });

async function attachPng(page: Page, origin: string) {
	await page.goto(new URL("/image", origin).href);
	await page.getByLabel("Operation", { exact: true }).selectOption("edit");
	const file = page.getByLabel("Reference image 1", { exact: true });
	await file.setInputFiles({
		name: "photo.png",
		mimeType: "image/png",
		buffer: await uprightPng(),
	});
	return file;
}

async function stored(page: Page, origin: string) {
	return (await page.request.get(new URL("/settings/files/state", origin).href)).json();
}

test("Skip leads to the offer, which keeps cleaning on and saves nothing until Continue", async ({
	page,
}) => {
	await withStudio(async (studio) => {
		const { origin } = studio;
		await claim(page, studio);
		await page.getByRole("link", { name: "Skip for now" }).click();
		await expect(page).toHaveURL(/\/settings\/files\?offer$/);
		await expect(page.getByRole("banner")).toContainText("Settings / Attached files");
		await expect(cleaningSwitch(page)).toBeChecked();
		await cleaningSwitch(page).click();
		await expect(page.getByText(/sends each file exactly as attached/)).toBeVisible();
		// The switch changes only this page until Continue.
		expect(await stored(page, origin.href)).toEqual({ enabled: true, revision: 0 });
		await cleaningSwitch(page).click();
		await page.getByRole("button", { name: "Continue to studio" }).click();
		await expect(page).toHaveURL(origin.href);
		expect(await stored(page, origin.href)).toEqual({ enabled: true, revision: 0 });
		const file = await attachPng(page, origin.href);
		await expect(file).toHaveAccessibleDescription(/Cleaned copy ready\./);
	});
});

test("turning cleaning off during setup gives Not cleaned", async ({ page }) => {
	await withStudio(async (studio) => {
		const { origin } = studio;
		await claim(page, studio);
		await page.getByRole("link", { name: "Skip for now" }).click();
		await cleaningSwitch(page).click();
		await page.getByRole("button", { name: "Continue to studio" }).click();
		await expect(page).toHaveURL(origin.href);
		expect(await stored(page, origin.href)).toEqual({ enabled: false, revision: 1 });
		const file = await attachPng(page, origin.href);
		await expect(file).toHaveAccessibleDescription(/File checked · Not cleaned\./);
		const copy = page.getByRole("region", { name: "Local copy", exact: true });
		await expect(copy.getByRole("img", { name: "Attached file" })).toBeVisible();
		await expect(copy).toContainText("Metadata removal is off in Settings.");
		await expect(copy.getByText("What survives cleanup")).toHaveCount(0);
	});
});

test("setup with an authenticator reaches the offer, and Return to Security and resume keep it", async ({
	page,
}) => {
	await withStudio(async (studio) => {
		const password = await claim(page, studio);
		await page.getByLabel("Current password").fill(password);
		await page.getByRole("button", { name: "Set up authenticator" }).click();
		const manual = (await page.locator("section code").first().textContent()) ?? "";
		await expect(page.getByRole("link", { name: "Return to Security" })).toHaveAttribute(
			"href",
			"/settings/security?offer",
		);
		await page
			.getByLabel("New authenticator code")
			.fill(new TOTP({ secret: manual }).generate({ timestamp: Date.now() }));
		await page.getByRole("button", { name: "Confirm authenticator" }).click();
		await expect(page.locator("section li")).toHaveCount(10);
		await page.getByRole("link", { name: "Done" }).click();
		await expect(page).toHaveURL(/\/settings\/files\?offer$/);
		await expect(page.getByRole("button", { name: "Continue to studio" })).toBeVisible();
	});
});

test("a change in this tab re-prepares the attached file, and a stale tab shows the stored value", async ({
	browser,
	page,
}) => {
	await withStudio(async (studio) => {
		const { origin } = studio;
		await claim(page, studio);
		await page.getByRole("link", { name: "Skip for now" }).click();
		await page.getByRole("button", { name: "Continue to studio" }).click();
		const file = await attachPng(page, origin.href);
		await expect(file).toHaveAccessibleDescription(/Cleaned copy ready\./);
		// Same tab: the draft keeps its file across client navigation and is prepared again.
		await page.getByRole("link", { name: "Settings" }).first().click();
		await page.getByRole("link", { name: "Attached files" }).first().click();
		await expect(page).toHaveURL(/\/settings\/files$/);
		await cleaningSwitch(page).click();
		await expect(page.getByRole("status")).toHaveText("Saved.");
		await page.getByRole("link", { name: "Image Studio" }).first().click();
		await expect(file).toHaveAccessibleDescription(/File checked · Not cleaned\./);

		const other = await secondTab(browser, page, origin.href);
		await page.goto(new URL("/settings/files", origin).href);
		await expect(cleaningSwitch(page)).not.toBeChecked();
		await cleaningSwitch(other).click();
		await expect(other.getByRole("status")).toHaveText("Saved.");
		// This tab last saw revision 1: its save is refused and shows the stored value.
		await cleaningSwitch(page).click();
		await expect(page.getByRole("status")).toHaveText("Changed in another tab");
		await expect(cleaningSwitch(page)).toBeChecked();
		expect(await stored(page, origin.href)).toEqual({ enabled: true, revision: 2 });
		await other.context().close();
	});
});

test("a failed save puts the switch and its description back to the stored value", async ({
	page,
}) => {
	await withStudio(async (studio) => {
		const { origin } = studio;
		await claim(page, studio);
		await page.goto(new URL("/settings/files", origin).href);
		const effect = page.getByText(/Siluet sends only a cleaned private copy/);
		let failure: "network" | "unavailable" = "network";
		await page.route("**/settings/files", async (route) => {
			if (route.request().method() !== "POST") return route.fallback();
			if (failure === "network") return route.abort();
			// The action's own answer when storage cannot save.
			return route.fulfill({
				status: 503,
				contentType: "application/json",
				body: JSON.stringify({
					type: "failure",
					status: 503,
					data: JSON.stringify([{ message: 1 }, "Siluet could not save this setting. Try again."]),
				}),
			});
		});
		for (const kind of ["network", "unavailable"] as const) {
			failure = kind;
			await cleaningSwitch(page).click();
			await expect(page.getByRole("status")).toHaveText(
				"Siluet could not save this setting. Try again.",
			);
			await expect(cleaningSwitch(page)).toBeChecked();
			await expect(effect).toBeVisible();
		}
		expect(await stored(page, origin.href)).toEqual({ enabled: true, revision: 0 });
	});
});

test("the access Retry link and a back-forward restore keep the offer", async ({ page }) => {
	await withStudio(async (studio, directory) => {
		const { origin } = studio;
		const password = await claim(page, studio);
		await page.getByLabel("Current password").fill(password);
		await page.getByRole("button", { name: "Set up authenticator" }).click();
		const manual = (await page.locator("section code").first().textContent()) ?? "";
		await page
			.getByLabel("New authenticator code")
			.fill(new TOTP({ secret: manual }).generate({ timestamp: Date.now() }));
		await page.getByRole("button", { name: "Confirm authenticator" }).click();
		await expect(page.locator("section li")).toHaveCount(10);
		await page.getByRole("link", { name: "Done" }).click();
		await expect(page).toHaveURL(/\/settings\/files\?offer$/);

		// Leaving by a category link and coming back restores the offer.
		await page.getByRole("link", { name: "Providers" }).first().click();
		await expect(page).toHaveURL(/\/settings\/providers$/);
		await page.goBack();
		await expect(page).toHaveURL(/\/settings\/files\?offer$/);
		await expect(page.getByRole("button", { name: "Continue to studio" })).toBeVisible();
		// So does a full page load and a return from the back-forward cache.
		await page.goto(new URL("/settings/providers", origin).href);
		await page.goBack();
		await expect(page).toHaveURL(/\/settings\/files\?offer$/);
		await expect(page.getByRole("button", { name: "Continue to studio" })).toBeVisible();

		// The authenticator key cannot be read: access fails with a Retry link built from
		// fixed keys that keeps the offer.
		const key = (await readdir(directory)).find((entry) => /^factor-.*[.]key$/.test(entry));
		if (!key) throw new Error("Missing fixture key.");
		await chmod(join(directory, key), 0);
		try {
			await page.goto(new URL("/settings/files?offer&next=%2Fother", origin).href);
			await expect(page.getByRole("heading", { name: "Studio access" })).toBeVisible();
			await expect(page.getByRole("link", { name: "Retry" })).toHaveAttribute(
				"href",
				"/settings/files?offer",
			);
			await page.goto(new URL("/settings/security?offer", origin).href);
			await expect(page.getByRole("link", { name: "Retry" })).toHaveAttribute(
				"href",
				"/settings/security?resume&offer",
			);
			await page.goto(new URL("/settings/files?offer", origin).href);
		} finally {
			await chmod(join(directory, key), 0o600);
		}
		await page.getByRole("link", { name: "Retry" }).click();
		await expect(page).toHaveURL(/\/settings\/files\?offer$/);
		await expect(page.getByRole("button", { name: "Continue to studio" })).toBeVisible();
	});
});

test("a save whose answer is lost shows what was stored", async ({ page }) => {
	await withStudio(async (studio) => {
		const { origin } = studio;
		await claim(page, studio);
		await page.goto(new URL("/settings/files", origin).href);
		let stateFails = false;
		await page.route("**/settings/files", async (route) => {
			if (route.request().method() !== "POST") return route.fallback();
			// The save reaches the server and commits; its answer is lost.
			await route.fetch();
			return route.abort();
		});
		await page.route("**/settings/files/state", (route) =>
			stateFails ? route.abort() : route.fallback(),
		);
		await cleaningSwitch(page).click();
		await expect(page.getByRole("status")).toHaveText("Saved.");
		await expect(cleaningSwitch(page)).not.toBeChecked();
		await expect(page.getByText(/Siluet sends each file exactly as attached/)).toBeVisible();
		expect(await stored(page, origin.href)).toEqual({ enabled: false, revision: 1 });
		// When the stored value cannot be read either, the page says so.
		stateFails = true;
		await cleaningSwitch(page).click();
		await expect(page.getByRole("status")).toHaveText(
			"Siluet could not confirm whether this setting was saved. Reload Settings to check.",
		);
		expect(await stored(page, origin.href)).toEqual({ enabled: true, revision: 2 });
	});
});

test("Continue with the default whose answer is lost reports it saved", async ({ page }) => {
	await withStudio(async (studio) => {
		const { origin } = studio;
		await claim(page, studio);
		await page.getByRole("link", { name: "Skip for now" }).click();
		await expect(page).toHaveURL(/\/settings\/files\?offer$/);
		await page.route("**/settings/files?offer", async (route) => {
			if (route.request().method() !== "POST") return route.fallback();
			await route.fetch({ maxRedirects: 0 });
			return route.abort();
		});
		// Keeping the default saves nothing new: the stored value matches at the same revision.
		await page.getByRole("button", { name: "Continue to studio" }).click();
		await expect(page.getByRole("status")).toHaveText("Saved.");
		await expect(cleaningSwitch(page)).toBeChecked();
		expect(await stored(page, origin.href)).toEqual({ enabled: true, revision: 0 });
	});
});

async function secondTab(browser: Browser, page: Page, origin: string) {
	const context = await browser.newContext({ storageState: await page.context().storageState() });
	const other = await context.newPage();
	await other.goto(new URL("/settings/files", origin).href);
	return other;
}

test("the switch saves without scripts", async ({ browser }) => {
	await withStudio(async (studio) => {
		const { origin } = studio;
		const scripted = await browser.newPage();
		await claim(scripted, studio);
		const context = await browser.newContext({
			javaScriptEnabled: false,
			storageState: await scripted.context().storageState(),
		});
		const page = await context.newPage();
		try {
			await page.goto(new URL("/settings/files", origin).href);
			await cleaningSwitch(page).uncheck();
			await page.getByRole("button", { name: "Save" }).click();
			await expect(cleaningSwitch(page)).not.toBeChecked();
			expect(await stored(page, origin.href)).toEqual({ enabled: false, revision: 1 });
		} finally {
			await context.close();
			await scripted.close();
		}
	});
});
