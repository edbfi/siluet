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

test("restored tabs stay within the challenge limits", async ({ browserName, context, studio }) => {
	// The studio answers the forty resumes within seconds. Opening forty Firefox windows and
	// loading the studio in each takes the browser far longer: 96–173 s measured with three
	// workers on a loaded eight-core host, against about ten seconds in Chromium.
	const firefox = browserName === "firefox";
	test.setTimeout(firefox ? 300000 : 90000);
	const { origin } = studio;
	const refused: string[] = [];
	let resumed = 0;
	context.on("response", (response) => {
		const { pathname } = new URL(response.url());
		if (!/^\/owner\/(?:challenge|resume)$/.test(pathname)) return;
		if (response.status() !== 200) refused.push(`${pathname} ${response.status()}`);
		else if (pathname === "/owner/resume") resumed++;
	});
	const tabs = await Promise.all(Array.from({ length: 40 }, () => context.newPage()));
	await Promise.all(tabs.map((tab) => tab.goto(`${origin}/jobs`)));
	// A limit refusal settles a tab on the error page instead, so each tab fails at once.
	for (const tab of tabs) {
		await expect(
			tab
				.getByRole("heading", { name: "No jobs yet" })
				.or(tab.getByRole("heading", { name: "Studio access" })),
		).toBeVisible({ timeout: firefox ? 120000 : 20000 });
		expect(refused).toEqual([]);
		await expect(tab.getByRole("heading", { name: "No jobs yet" })).toBeVisible();
	}
	// Forty resumes ran, so the limits were exercised, and none was refused late.
	expect(resumed).toBeGreaterThanOrEqual(40);
	expect(refused).toEqual([]);
	await Promise.all(tabs.map((tab) => tab.close()));
});

/** Security POSTs this page sent, as the server saw them. */
function securityPosts(page: Page) {
	const sent: { bearer: string; status: Promise<number> }[] = [];
	page.on("request", (request) => {
		if (request.method() !== "POST" || !request.url().includes("/settings/security")) return;
		sent.push({
			bearer: request.headers().authorization ?? "",
			status: request.response().then((response) => response?.status() ?? 0),
		});
	});
	return sent;
}

test("Forward while Back's navigation is in flight keeps the codes dialog, with focus inside after the commit", async ({
	page,
	studio,
}) => {
	const { origin, password } = studio;
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
	// Back's data load is held in flight; Forward supersedes it.
	const requested = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	await page.route("**/settings/providers/__data.json**", async (route) => {
		requested.resolve();
		await release.promise;
		await route.continue().catch(() => {});
	});
	await page.goBack();
	await requested.promise;
	await page.goForward();
	release.resolve();
	await expect(page).toHaveURL(`${origin}/settings/security`);
	await expect(page.getByRole("heading", { name: "Security" })).toBeAttached();
	await expect(dialog.locator("li")).toHaveCount(10);
	expect(await page.evaluate(() => document.querySelector("dialog")?.matches(":modal"))).toBe(true);
	await expect(done).toBeFocused();
	await done.click();
	await expect(dialog).toHaveCount(0);
	await expect(page.getByText(/Authenticator on · 10 recovery\s+codes remaining/)).toBeVisible();
});

test("another tab regenerating marks shown codes replaced; Done loads Security on its session", async ({
	page,
	context,
	studio,
}) => {
	const { origin, password } = studio;
	await enrollment(page, origin, password);
	await page.getByRole("button", { name: "Confirm authenticator" }).click();
	const dialog = page.getByRole("dialog");
	await expect(dialog.locator("li")).toHaveCount(10);
	const codes = await dialog.locator("li").allTextContents();
	// Tab B in the same browser regenerates the codes A is showing.
	const other = await context.newPage();
	await other.goto(`${origin}/settings/security`);
	await other.getByLabel("Current password").fill(password);
	await other.getByLabel("Authenticator or recovery code").fill(codes[0]);
	await other.getByLabel("Security action").selectOption("regenerate");
	await other.getByRole("button", { name: "Continue" }).click();
	const replacement = other.getByRole("dialog");
	await expect(replacement.locator("li")).toHaveCount(10);
	await page.evaluate(() => window.dispatchEvent(new Event("focus")));
	await expect(dialog).toContainText("A later Security change replaced these codes.");
	await expect(dialog.locator("li")).toHaveCount(10);
	const loaded = page.waitForEvent("load");
	await dialog.getByRole("button", { name: "Done" }).click();
	await loaded;
	await expect(page).toHaveURL(`${origin}/settings/security`);
	await expect(page.getByRole("dialog")).toHaveCount(0);
	await expect(page.getByText(/Authenticator on · 10 recovery\s+codes remaining/)).toBeVisible();
	expect(await sessionOf(page, origin)).toBe(await sessionOf(other, origin));
	await replacement.getByRole("button", { name: "Done" }).click();
});

test("another browser's Security change signs out a tab showing codes, with the caveat", async ({
	page,
	browser,
	studio,
}) => {
	const { origin, password } = studio;
	await enrollment(page, origin, password);
	await page.getByRole("button", { name: "Confirm authenticator" }).click();
	const dialog = page.getByRole("dialog");
	await expect(dialog.locator("li")).toHaveCount(10);
	const codes = await dialog.locator("li").allTextContents();
	const elsewhere = await browser.newContext();
	try {
		const tab = await elsewhere.newPage();
		const pending = await signInOwner(tab, origin, password, "owner");
		if (!("proof" in pending)) throw new Error("Expected a pending sign-in.");
		const factor = await signedInPage(
			tab,
			"factor",
			"/owner/factor",
			{ proof: pending.proof, code: codes[0] },
			{ proof: pending.proof },
		);
		expect(factor.status).toBe(200);
		await tab.goto(`${origin}/settings/security`);
		await tab.getByLabel("Current password").fill(password);
		await tab.getByLabel("Authenticator or recovery code").fill(codes[1]);
		await tab.getByLabel("Security action").selectOption("regenerate");
		await tab.getByRole("button", { name: "Continue" }).click();
		await expect(tab.getByRole("dialog").locator("li")).toHaveCount(10);
	} finally {
		await elsewhere.close();
	}
	await page.evaluate(() => window.dispatchEvent(new Event("focus")));
	await expect(dialog).toContainText("Signed out.");
	await expect(dialog).toContainText("hold only if two-step sign-in has not changed since");
	await dialog.getByRole("button", { name: "Done" }).click();
	await expect(page).toHaveURL(`${origin}/sign-in`);
	await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
});

test("a shown candidate, an address-bar leave and Back give a clean Security page that offers Resume", async ({
	page,
	studio,
}) => {
	const { origin, password } = studio;
	await page.goto(`${origin}/settings/security`);
	await page.getByLabel("Current password").fill(password);
	await page.getByRole("button", { name: "Set up authenticator" }).click();
	await expect(page.getByRole("heading", { name: "Connect your authenticator" })).toBeVisible();
	const seed = (await page.locator("section code").first().textContent()) ?? "";
	expect(seed).not.toBe("");
	await page.goto(`${origin}/jobs`);
	await expect(page.getByRole("heading", { name: "No jobs yet" })).toBeVisible();
	await page.goBack();
	await expect(page).toHaveURL(`${origin}/settings/security`);
	const resume = page.getByRole("link", { name: "Resume authenticator setup" });
	await expect(resume).toBeVisible();
	await expect(page.getByRole("heading", { name: "Connect your authenticator" })).toHaveCount(0);
	await expect(page.getByAltText("Authenticator setup QR code")).toHaveCount(0);
	expect(await page.content()).not.toContain(seed);
	// Resume reopens this tab's own candidate.
	await resume.click();
	await expect(page.getByRole("heading", { name: "Connect your authenticator" })).toBeVisible();
	await expect(page.locator("section code").first()).toHaveText(seed);
});

test("a double submit of a Security change changes it once", async ({ page, studio }) => {
	const { origin, password } = studio;
	const posts = securityPosts(page);
	await enrollment(page, origin, password);
	expect(posts).toHaveLength(1);
	// A double click on Confirm sends one change.
	await page.getByRole("button", { name: "Confirm authenticator" }).dblclick();
	const dialog = page.getByRole("dialog");
	await expect(dialog.locator("li")).toHaveCount(10);
	expect(posts).toHaveLength(2);
	const codes = await dialog.locator("li").allTextContents();
	await dialog.getByRole("button", { name: "Done" }).click();
	await expect(page.getByText(/Authenticator on · 10 recovery\s+codes remaining/)).toBeVisible();
	// Two submits in one turn, before the button can disable: the second is cancelled.
	await page.getByLabel("Current password").fill(password);
	await page.getByLabel("Authenticator or recovery code").fill(codes[0]);
	await page.getByLabel("Security action").selectOption("regenerate");
	await page.evaluate(() => {
		const form = document.querySelector<HTMLFormElement>("section form");
		form?.requestSubmit();
		form?.requestSubmit();
	});
	await expect(dialog.locator("li")).toHaveCount(10);
	expect(posts).toHaveLength(3);
	expect(await Promise.all(posts.map((post) => post.status))).toEqual([200, 200, 200]);
	await dialog.getByRole("button", { name: "Done" }).click();
	await expect(page.getByText(/Authenticator on · 10 recovery\s+codes remaining/)).toBeVisible();
});

test("a bearer expiring right before submit still submits once, with a fresh bearer", async ({
	page,
	context,
	studio,
}) => {
	const { origin, password } = studio;
	// The tab's clock: its bearer renews after nine minutes.
	await page.clock.install();
	const posts = securityPosts(page);
	const resumes: number[] = [];
	page.on("request", (request) => {
		if (request.url().endsWith("/owner/resume")) resumes.push(posts.length);
	});
	await enrollment(page, origin, password);
	await page.clock.fastForward("09:30");
	await page.getByRole("button", { name: "Confirm authenticator" }).click();
	const dialog = page.getByRole("dialog");
	await expect(dialog.locator("li")).toHaveCount(10);
	expect(posts).toHaveLength(2);
	// The client renewed between the two posts, and the change went out once with the new bearer.
	expect(resumes.filter((before) => before === 1)).toHaveLength(1);
	expect(posts[1].bearer).not.toBe(posts[0].bearer);
	expect(await posts[1].status).toBe(200);
	const codes = await dialog.locator("li").allTextContents();
	await dialog.getByRole("button", { name: "Done" }).click();
	await expect(page.getByText(/Authenticator on · 10 recovery\s+codes remaining/)).toBeVisible();

	// The server retires the bearer the client still thinks is live: the hook refuses it,
	// the change is resent once with a renewed bearer and applies once.
	const other = await context.newPage();
	await other.goto(`${origin}/sign-in`);
	let first = true;
	await page.route("**/settings/security", async (route) => {
		if (route.request().method() !== "POST" || !first) return route.fallback();
		first = false;
		const bearer = (route.request().headers().authorization ?? "").slice("Bearer ".length);
		const retired = await signedInPage(
			other,
			"resume",
			"/owner/resume",
			{ previous: bearer },
			"key",
		);
		expect(retired.status).toBe(200);
		await route.fallback();
	});
	await page.getByLabel("Current password").fill(password);
	await page.getByLabel("Authenticator or recovery code").fill(codes[0]);
	await page.getByLabel("Security action").selectOption("regenerate");
	await page.getByRole("button", { name: "Continue" }).click();
	await expect(dialog.locator("li")).toHaveCount(10);
	expect(posts).toHaveLength(4);
	expect(await posts[2].status).toBe(401);
	expect(await posts[3].status).toBe(200);
	expect(posts[3].bearer).not.toBe(posts[2].bearer);
	await dialog.getByRole("button", { name: "Done" }).click();
	await expect(page.getByText(/Authenticator on · 10 recovery\s+codes remaining/)).toBeVisible();
});

/**
 * Hold this page's sign-out: `before` keeps it from the server until released; otherwise the
 * server answers at once and only the response waits. Resolves with the server's status.
 */
async function holdSignOut(page: Page, release: Promise<void>, before: boolean) {
	const sent = Promise.withResolvers<void>();
	const status = Promise.withResolvers<number>();
	await page.route("**/owner/sign-out", async (route) => {
		sent.resolve();
		if (before) await release;
		const response = await route.fetch();
		status.resolve(response.status());
		if (!before) await release;
		await route.fulfill({ response }).catch(() => {});
	});
	return { sent: sent.promise, status: status.promise };
}
const liveSession = async (page: Page, origin: string, bearer: string) => {
	const response = await page.request.get(`${origin}/owner/session`, {
		headers: { authorization: `Bearer ${bearer}` },
	});
	return response.ok() ? ((await response.json()).sessionId as string) : response.status();
};

test("a held sign-out answered 200 before a fresh login changes nothing when it lands", async ({
	page,
	context,
	studio,
}) => {
	const { origin, password } = studio;
	await page.goto(origin);
	const documents: string[] = [];
	page.on("request", (request) => {
		if (request.isNavigationRequest()) documents.push(new URL(request.url()).pathname);
	});
	const release = Promise.withResolvers<void>();
	const held = await holdSignOut(page, release.promise, false);
	await page.getByRole("button", { name: "Sign out" }).click();
	expect(await held.status).toBe(200);
	// This browser signs in again before the 200 reaches the tab.
	const fresh = await signInOwner(await context.newPage(), origin, password, "owner");
	if (!("bearer" in fresh)) throw new Error("Expected a session.");
	release.resolve();
	await expect.poll(() => documents).toContain("/sign-in");
	// The fresh login survives, and the tab joins it.
	await expect(page).toHaveURL(`${origin}/`);
	await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
	expect(await liveSession(page, origin, fresh.bearer)).toBe(fresh.sessionId);
	expect(await sessionOf(page, origin)).toBe(fresh.sessionId);
});

test("a held sign-out signs out the rotated successor of its login", async ({
	page,
	context,
	studio,
}) => {
	const { origin, password } = studio;
	await page.goto(origin);
	// Another tab opens an authenticator candidate; it is confirmed without telling this tab.
	const other = await context.newPage();
	const seed = await enrollment(other, origin, password);
	const proof = await other.locator('input[name="proof"]').inputValue();
	const release = Promise.withResolvers<void>();
	const held = await holdSignOut(page, release.promise, true);
	await page.getByRole("button", { name: "Sign out" }).click();
	await held.sent;
	const before = await sessionOf(other, origin);
	const rotated = await ownerRequest(other).post(`${origin}/settings/security`, {
		headers: { origin, "x-sveltekit-action": "true" },
		form: { change: "enable", proof, code: new TOTP({ secret: seed }).generate() },
	});
	expect((await rotated.json()).type).toBe("success");
	ownerRequest(other).reset();
	expect(await sessionOf(other, origin)).not.toBe(before);
	release.resolve();
	expect(await held.status).toBe(200);
	await expect(page).toHaveURL(`${origin}/sign-in`);
	await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
	const resumed = await signedInPage(other, "resume", "/owner/resume", {}, "key");
	expect(resumed.status).toBe(401);
});

test("a late sign-out meets a fresh login: 409, the fresh login survives and the tab joins it", async ({
	page,
	context,
	studio,
}) => {
	const { origin, password } = studio;
	await page.goto(origin);
	const release = Promise.withResolvers<void>();
	const held = await holdSignOut(page, release.promise, true);
	await page.getByRole("button", { name: "Sign out" }).click();
	await held.sent;
	const fresh = await signInOwner(await context.newPage(), origin, password, "owner");
	if (!("bearer" in fresh)) throw new Error("Expected a session.");
	// The 409 makes the tab check; it finds the fresh login's session and reloads into it.
	const reloaded = page.waitForEvent("load");
	release.resolve();
	expect(await held.status).toBe(409);
	await reloaded;
	await expect(page).toHaveURL(`${origin}/`);
	await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
	expect(await liveSession(page, origin, fresh.bearer)).toBe(fresh.sessionId);
	expect(await sessionOf(page, origin)).toBe(fresh.sessionId);
});

test("a back/forward-cache restore with a pending destination starts one document load and no session check", async ({
	page,
	studio,
}) => {
	// No engine restores Siluet's no-store documents under Playwright: Chromium reports
	// `response-cache-control-no-store`, and Playwright's Firefox restores no page at all. So
	// the built page gets the restore's own events, and the real requests that follow count.
	const { origin, password } = studio;
	await page.goto(`${origin}/settings/security`);
	await page.getByLabel("Current password").fill(password);
	await page.getByRole("button", { name: "Set up authenticator" }).click();
	const candidate = page.getByRole("heading", { name: "Connect your authenticator" });
	await expect(candidate).toBeVisible();
	const seen: string[] = [];
	page.on("request", (request) => {
		const path = new URL(request.url()).pathname;
		if (request.isNavigationRequest()) seen.push(`document ${path}`);
		else if (path === "/owner/session" || path === "/owner/resume") seen.push(path);
	});
	// Leaving into the cache clears the candidate and registers Security as the destination.
	await page.evaluate(() =>
		dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true })),
	);
	await expect(candidate).toHaveCount(0);
	const loaded = page.waitForEvent("load");
	await page.evaluate(() =>
		dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })),
	);
	await loaded;
	await expect(page.getByRole("link", { name: "Resume authenticator setup" })).toBeVisible();
	await page.waitForLoadState("networkidle");
	// One document load and no check; the new document then binds with one resume.
	expect(seen).toEqual(["document /settings/security", "/owner/resume"]);
});

test("a tab restored from the cache after leaving for another session loads afresh", async ({
	page,
	context,
	studio,
}) => {
	const { origin, password } = studio;
	await page.goto(`${origin}/jobs`);
	await expect(page.getByRole("heading", { name: "No jobs yet" })).toBeVisible();
	// Another tab signs this browser in again; this tab's next check finds another session ID.
	await signInOwner(await context.newPage(), origin, password, "owner");
	// The reload that check starts is held, so the old document is still there to restore.
	const reloads: string[] = [];
	const held = Promise.withResolvers<void>();
	await page.route(
		(url) => url.pathname === "/jobs",
		async (route) => {
			if (!route.request().isNavigationRequest()) return route.fallback();
			reloads.push(route.request().url());
			if (reloads.length === 1) await held.promise;
			await route.fallback().catch(() => {});
		},
	);
	// Chromium answers no evaluation while that load is pending, so the page arms the restore:
	// once the load starts, it leaves into the cache and comes back.
	await page.evaluate(() => {
		addEventListener(
			"beforeunload",
			() =>
				setTimeout(() => {
					dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
					dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
				}, 200),
			{ once: true },
		);
		dispatchEvent(new Event("focus"));
	});
	// The tab is on a session it left, so it loads again.
	await expect.poll(() => reloads.length).toBe(2);
	held.resolve();
	await expect(page.getByRole("heading", { name: "No jobs yet" })).toBeVisible();
	expect(await sessionOf(page, origin)).toBeTruthy();
});

test("a hidden tab keeps its bearer, so a request from it goes out without renewing", async ({
	page,
	studio,
}) => {
	const { origin } = studio;
	await page.goto(`${origin}/jobs`);
	await expect(page.getByRole("heading", { name: "No jobs yet" })).toBeVisible();
	await page.waitForLoadState("networkidle");
	const renewals: string[] = [];
	page.on("request", (request) => {
		if (new URL(request.url()).pathname === "/owner/resume") renewals.push(request.url());
	});
	const status = await page.evaluate(async () => {
		Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
		document.dispatchEvent(new Event("visibilitychange"));
		// As a pagehide keepalive would, right after the tab was hidden.
		const response = await fetch("/settings/files/state", { keepalive: true });
		Reflect.deleteProperty(document, "visibilityState");
		return response.status;
	});
	expect(status).toBe(200);
	expect(renewals).toEqual([]);
});

test("Done after Back moved the URL loads Security on the new session, and Back stays signed in", async ({
	page,
	context,
	studio,
}) => {
	const { origin, password } = studio;
	// Routed entries: /jobs, Providers, then Security.
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
	// Another tab in this browser signs in again: the codes are held for Done.
	const other = await context.newPage();
	const pending = await signInOwner(other, origin, password, "owner");
	if (!("proof" in pending)) throw new Error("Expected a pending sign-in.");
	const code = new TOTP({ secret: seed }).generate({ timestamp: Date.now() + 30000 });
	const factor = await signedInPage(
		other,
		"factor",
		"/owner/factor",
		{ proof: pending.proof, code },
		{ proof: pending.proof },
	);
	expect(factor.status).toBe(200);
	await page.evaluate(() => window.dispatchEvent(new Event("focus")));
	await expect(dialog).toContainText("Session changed.");
	await page.goBack();
	await expect(page).toHaveURL(`${origin}/settings/providers`);
	await expect(dialog.locator("li")).toHaveCount(10);
	const loaded = page.waitForEvent("load");
	await dialog.getByRole("button", { name: "Done" }).click();
	await loaded;
	await expect(page).toHaveURL(`${origin}/settings/security`);
	await expect(page.getByText(/Authenticator on · 10 recovery\s+codes remaining/)).toBeVisible();
	// Done replaced the moved entry: Back reaches the studio on the new session.
	await page.goBack();
	await expect(page).toHaveURL(`${origin}/jobs`);
	await expect(page.getByRole("heading", { name: "No jobs yet" })).toBeVisible();
	expect(await sessionOf(page, origin)).toBe(await sessionOf(other, origin));
});

test("onboarding Done from a resumed candidate continues to attached files", async ({
	page,
	studio,
}) => {
	const { origin, password } = studio;
	await page.goto(`${origin}/settings/security?offer`);
	await page.getByLabel("Current password").fill(password);
	await page.getByRole("button", { name: "Set up authenticator" }).click();
	const seed = (await page.locator("section code").first().textContent()) ?? "";
	await page.goto(`${origin}/jobs`);
	await page.goBack();
	await page.getByRole("link", { name: "Resume authenticator setup" }).click();
	await expect(page).toHaveURL(/\/settings\/security\?resume=[0-9a-f]{64}&offer$/);
	await page.getByLabel("New authenticator code").fill(new TOTP({ secret: seed }).generate());
	await page.getByRole("button", { name: "Confirm authenticator" }).click();
	const dialog = page.getByRole("dialog");
	await expect(dialog.locator("li")).toHaveCount(10);
	await dialog.getByRole("button", { name: "Done" }).click();
	await expect(page).toHaveURL(`${origin}/settings/files?offer`);
	await expect(page.getByRole("button", { name: "Continue to studio" })).toBeVisible();
});
