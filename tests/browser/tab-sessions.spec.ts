import { rm } from "node:fs/promises";
import { expect, type Page, type Route } from "@playwright/test";
import { TOTP } from "otpauth";
import { createOwnerDirectory } from "../fixtures/owner-directory";
import { startStudio } from "./built-studio";
import { claimOwner, ownerRequest, signedInPage, signInOwner } from "./owner-session";
import { test as base } from "./studio-test";

type Studio = Awaited<ReturnType<typeof startStudio>>;
const test = base.extend<{ studio: { server: Studio; origin: string; password: string } }>({
	studio: async ({ page }, use) => {
		const directory = await createOwnerDirectory();
		const server = await startStudio(directory);
		try {
			const password = crypto.randomUUID();
			await claimOwner(page, server, password, "owner");
			await use({ server, origin: server.origin.origin, password });
		} finally {
			await server.stop();
			await rm(directory, { recursive: true, force: true });
		}
	},
});

/** Start enrollment on the Security page; returns the code to confirm with. */
async function enrollment(page: Page, origin: string, password: string) {
	await page.goto(`${origin}/settings/security`);
	await page.getByLabel("Current password").fill(password);
	await page.getByRole("button", { name: "Set up authenticator" }).click();
	const seed = (await page.locator("section code").first().textContent()) ?? "";
	await page.getByLabel("New authenticator code").fill(new TOTP({ secret: seed }).generate());
	return seed;
}
/**
 * Hold the Security response until `release` resolves; the server commits at once.
 * Resolves once the server has answered.
 */
async function holdSecurity(page: Page, release: Promise<void>) {
	const answered = Promise.withResolvers<void>();
	await page.route("**/settings/security**", async (route: Route) => {
		if (route.request().method() !== "POST") return route.fallback();
		const response = await route.fetch();
		answered.resolve();
		await release;
		await route.fulfill({ response });
	});
	return { answered: answered.promise };
}
const sessionOf = async (page: Page, origin: string) =>
	(await (await ownerRequest(page).get(`${origin}/owner/session`)).json()).sessionId as string;

test("a lone Security change adopts its successor and keeps the codes modal until Done", async ({
	page,
	studio,
}) => {
	const { origin, password } = studio;
	// Routed entries: Back and Forward stay in this document.
	await page.goto(`${origin}/jobs`);
	await page.getByRole("link", { name: "Settings" }).first().click();
	await page.getByRole("link", { name: "Security" }).first().click();
	await page.getByLabel("Current password").fill(password);
	await page.getByRole("button", { name: "Set up authenticator" }).click();
	const seed = (await page.locator("section code").first().textContent()) ?? "";
	await page.getByLabel("New authenticator code").fill(new TOTP({ secret: seed }).generate());
	await page.getByRole("button", { name: "Confirm authenticator" }).click();
	const dialog = page.getByRole("dialog");
	await expect(dialog.locator("li")).toHaveCount(10);
	const done = dialog.getByRole("button", { name: "Done" });
	await expect(done).toBeFocused();
	// Record every close from before the first Escape.
	await page.evaluate(() => {
		const element = document.querySelector("dialog");
		(globalThis as unknown as { closes: number }).closes = 0;
		element?.addEventListener("close", () => {
			(globalThis as unknown as { closes: number }).closes++;
		});
	});
	const modal = () => page.evaluate(() => document.querySelector("dialog")?.matches(":modal"));
	// Two Escapes with no click between, focused on Done and then blurred to the body.
	for (const blurred of [false, true]) {
		if (blurred) await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
		await page.keyboard.press("Escape");
		await page.keyboard.press("Escape");
		expect(await modal()).toBe(true);
		await expect(dialog.locator("li")).toHaveCount(10);
	}
	expect(await page.evaluate(() => (globalThis as unknown as { closes: number }).closes)).toBe(0);
	// The page beneath is inert: a click lands nowhere, and Back keeps the dialog with focus inside.
	await page.mouse.click(5, 5);
	expect(await modal()).toBe(true);
	await page.goBack();
	await expect(page).toHaveURL(`${origin}/settings/providers`);
	await expect(dialog.locator("li")).toHaveCount(10);
	await expect(done).toBeFocused();
	await page.goForward();
	await expect(done).toBeFocused();
	await done.click();
	await expect(dialog).toHaveCount(0);
	// The tab adopted the successor: its private requests keep working.
	await expect(page.getByText(/Authenticator on · 10 recovery\s+codes remaining/)).toBeVisible();
	expect((await ownerRequest(page).get(`${origin}/jobs/__data.json`)).status()).toBe(200);
	// Close and reload show no dialog.
	await page.reload();
	await expect(dialog).toHaveCount(0);
});

test("the drawer closes when codes arrive, and Done works by keyboard", async ({
	page,
	studio,
}) => {
	const { origin, password } = studio;
	await page.setViewportSize({ width: 360, height: 740 });
	await enrollment(page, origin, password);
	const release = Promise.withResolvers<void>();
	await holdSecurity(page, release.promise);
	await page.getByRole("button", { name: "Confirm authenticator" }).click();
	await page.getByRole("button", { name: "Menu", exact: true }).click();
	await expect(page.getByRole("dialog").getByRole("button", { name: "Close menu" })).toBeVisible();
	release.resolve();
	const codes = page.getByRole("dialog").filter({ hasText: "Save your recovery codes" });
	await expect(codes.locator("li")).toHaveCount(10);
	await expect(page.getByRole("button", { name: "Close menu" })).toHaveCount(0);
	const done = codes.getByRole("button", { name: "Done" });
	await expect(done).toBeFocused();
	await page.keyboard.press("Enter");
	await expect(codes).toHaveCount(0);
});

test("a Security change that commits before another tab's sign-in shows its codes, then the tab joins the sign-in", async ({
	page,
	context,
	studio,
}) => {
	const { origin, password } = studio;
	const draft = await context.newPage();
	await draft.goto(`${origin}/image`);
	await draft.getByRole("textbox", { name: "Prompt", exact: true }).fill("A private draft.");
	const seed = await enrollment(page, origin, password);
	const release = Promise.withResolvers<void>();
	const { answered: committed } = await holdSecurity(page, release.promise);
	await page.getByRole("button", { name: "Confirm authenticator" }).click();
	await committed;
	// The rotation has committed; tab C now signs this browser in again, with the new factor.
	const other = await context.newPage();
	const pending = await signInOwner(other, origin, password, "owner");
	if (!("proof" in pending)) throw new Error("Expected a pending sign-in.");
	const code = new TOTP({ secret: seed }).generate({ timestamp: Date.now() + 30000 });
	const factor = await signedInPage(
		other,
		"factor",
		"/owner/factor",
		{ proof: pending.proof, code },
		{
			proof: pending.proof,
		},
	);
	expect(factor.status).toBe(200);
	release.resolve();
	const dialog = page.getByRole("dialog");
	await expect(dialog.locator("li")).toHaveCount(10);
	await page.evaluate(() => window.dispatchEvent(new Event("focus")));
	await expect(dialog).toContainText("Session changed.");
	await expect(dialog).toContainText("hold only if two-step sign-in has not changed since");
	// Private requests wait while the codes are held; Done loads Security on C's session.
	const loaded = page.waitForEvent("load");
	await dialog.getByRole("button", { name: "Done" }).click();
	await loaded;
	await expect(page).toHaveURL(`${origin}/settings/security`);
	await expect(page.getByRole("dialog")).toHaveCount(0);
	await expect(page.getByLabel("Current password")).toBeVisible();
	expect(await sessionOf(page, origin)).toBe(await sessionOf(other, origin));
	// The sibling draft was dropped with its session.
	await draft.evaluate(() => window.dispatchEvent(new Event("focus")));
	await expect(draft.getByRole("textbox", { name: "Prompt", exact: true })).toHaveValue("");
});

test("a Security change after another tab's sign-in shows no codes and joins the sign-in", async ({
	page,
	context,
	studio,
}) => {
	const { origin, password } = studio;
	await enrollment(page, origin, password);
	const other = await context.newPage();
	await signInOwner(other, origin, password, "owner");
	const reloaded = page.waitForEvent("load");
	await page.getByRole("button", { name: "Confirm authenticator" }).click();
	await reloaded;
	await expect(page.getByRole("dialog")).toHaveCount(0);
	await expect(page).toHaveURL(`${origin}/settings/security`);
	// The authenticator was not enabled: the enrollment form is offered again.
	await expect(page.getByRole("button", { name: "Set up authenticator" })).toBeVisible();
	expect(await sessionOf(page, origin)).toBe(await sessionOf(other, origin));
});

test("restored tabs stay within the challenge limits", async ({ context, studio }) => {
	test.setTimeout(90000);
	const { origin } = studio;
	const tabs = await Promise.all(Array.from({ length: 40 }, () => context.newPage()));
	await Promise.all(tabs.map((tab) => tab.goto(`${origin}/jobs`)));
	for (const tab of tabs)
		await expect(tab.getByRole("heading", { name: "No jobs yet" })).toBeVisible();
	await Promise.all(tabs.map((tab) => tab.close()));
});
