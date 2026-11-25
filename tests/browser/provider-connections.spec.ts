import { randomUUID } from "node:crypto";
import { readFile, rm, unlink } from "node:fs/promises";
import { join } from "node:path";
import { type APIRequestContext, expect, type Page } from "@playwright/test";
import { jobResponses } from "../fixtures/job-responses";
import { createOwnerDirectory } from "../fixtures/owner-directory";
import {
	providerFixtureKeys as keys,
	providerFixtureAccount,
	startProviderFixtures,
} from "../fixtures/provider-connections";
import { startStudio } from "./built-studio";
import { test } from "./studio-test";

type Studio = Awaited<ReturnType<typeof startStudio>>;

const settingsUrl = (studio: Studio) => new URL("/settings/providers", studio.origin).href;

async function claimStudio(page: Page, studio: Studio) {
	await expect.poll(studio.token).not.toBe("");
	await page.goto(new URL("/setup", studio.origin).href);
	await page.getByLabel("Claim token").fill(studio.token());
	await page.getByLabel("Username", { exact: true }).fill("provider-owner");
	await page.getByLabel("Password", { exact: true }).fill(randomUUID());
	await page.getByRole("button", { name: "Claim studio" }).press("Enter");
	await page.getByRole("link", { name: "Skip for now" }).click();
	await page.getByRole("button", { name: "Continue to studio" }).click();
	await expect(page).toHaveURL(studio.origin.href);
}

async function selectProvider(page: Page, name: "Poyo.ai" | "ToAPIs") {
	const link = page.getByRole("link", { name, exact: true });
	await link.press("Enter");
	await expect(link).toHaveAttribute("aria-current", "page");
}

async function submit(page: Page, button: "Connect" | "Replace key" | "Remove key", key = "") {
	if (key) await page.getByLabel("API key").fill(key);
	const post = page.waitForResponse((response) => response.request().method() === "POST");
	await page.getByRole("button", { name: button, exact: true }).press("Enter");
	const response = await post;
	expect(response.headers()["cache-control"]).toBe("no-store");
	assertRedacted(await response.text());
	await expect(page.getByLabel("API key")).toHaveValue("");
	return response.status();
}

function assertRedacted(text: string) {
	for (const secret of [...Object.values(keys), providerFixtureAccount]) {
		expect(text).not.toContain(secret);
	}
}

function postAction(
	client: APIRequestContext,
	studio: Studio,
	action: "connect" | "remove",
	provider: string,
	key = "",
	origin = studio.origin.origin,
) {
	return client.post(`${settingsUrl(studio)}?/${action}&provider=${provider}`, {
		headers: { Origin: origin, Accept: "application/json", "x-sveltekit-action": "true" },
		form: { provider, ...(key ? { key } : {}) },
		maxRedirects: 0,
	});
}

test("built Settings checks, replaces, restores and removes encrypted connections independently", async ({
	browser,
	page,
}) => {
	const directory = await createOwnerDirectory();
	const fixtures = startProviderFixtures();
	const diagnostics: string[] = [];
	let server: Studio | undefined;
	try {
		server = await startStudio(directory, "0", false, fixtures.env);
		const { origin } = server;
		const external: string[] = [];
		await page.route("**/*", (route) => {
			const url = new URL(route.request().url());
			if (url.origin === origin.origin) return route.continue();
			external.push(url.origin);
			return route.abort();
		});
		await claimStudio(page, server);

		const visitor = await browser.newContext();
		try {
			const denied = await visitor.request.get(settingsUrl(server), { maxRedirects: 0 });
			expect(denied.status()).toBe(303);
			expect(denied.headers().location).toBe("/sign-in");
			expect(
				(await postAction(visitor.request, server, "connect", "poyo", keys.poyo)).status(),
			).toBe(401);
		} finally {
			await visitor.close();
		}
		const wrongOrigin = await postAction(
			page.request,
			server,
			"connect",
			"poyo",
			keys.poyo,
			"http://localhost",
		);
		expect(wrongOrigin.status()).toBe(403);
		assertRedacted(await wrongOrigin.text());
		const invalidProvider = await postAction(page.request, server, "connect", "invalid", keys.poyo);
		expect(invalidProvider.status()).toBe(400);
		assertRedacted(await invalidProvider.text());
		expect(fixtures.requests).toEqual([]);

		await page.getByRole("link", { name: "Settings", exact: true }).press("Enter");
		await expect(page.getByRole("heading", { name: "Provider connections" })).toBeVisible();
		await expect(page.getByText("Disconnected", { exact: true })).toBeVisible();
		expect(await submit(page, "Connect", keys.poyo)).toBe(200);
		await expect(page.getByRole("button", { name: "Replace key" })).toBeFocused();
		await expect(page.getByRole("status")).toHaveText("Key accepted and saved.");
		const acceptance = page.locator("time");
		await expect(acceptance).toBeVisible();
		const poyoAccepted = await acceptance.getAttribute("datetime");

		expect(await submit(page, "Replace key", keys.rejected)).toBe(422);
		await expect(page.getByRole("alert")).toHaveText("The provider rejected this key.");
		await expect(acceptance).toHaveAttribute("datetime", String(poyoAccepted));
		expect(await submit(page, "Replace key", keys.unavailable)).toBe(503);
		await expect(page.getByRole("alert")).toHaveText(
			"The provider check is unavailable. Try again later.",
		);
		await expect(acceptance).toHaveAttribute("datetime", String(poyoAccepted));
		expect(await submit(page, "Replace key", keys.poyo)).toBe(429);
		await expect(page.getByRole("alert")).toContainText("Too many checks");
		expect(fixtures.requests).toEqual([
			{ path: "/poyo/balance", method: "GET", key: keys.poyo },
			{ path: "/poyo/balance", method: "GET", key: keys.rejected },
			{ path: "/poyo/balance", method: "GET", key: keys.unavailable },
		]);

		await selectProvider(page, "ToAPIs");
		await expect(page.getByText("Disconnected", { exact: true })).toBeVisible();
		expect(await submit(page, "Connect", keys.restricted)).toBe(200);
		await expect(page.getByText("Seedream 5.5 access unavailable.")).toBeVisible();
		expect(await submit(page, "Replace key", keys.toapis)).toBe(200);
		await expect(page.getByText("Seedream 5.5 access unavailable.")).toHaveCount(0);
		await expect(page.getByText("Connected", { exact: true })).toBeVisible();
		const toapisAccepted = await acceptance.getAttribute("datetime");

		const snapshot = await page.reload();
		expect(snapshot?.headers()["cache-control"]).toBe("no-store");
		assertRedacted((await snapshot?.text()) ?? "");
		assertRedacted(await page.content());
		assertRedacted(await page.evaluate(() => JSON.stringify([localStorage, sessionStorage])));
		expect(external).toEqual([]);
		await server.stop();
		diagnostics.push(server.diagnostics());
		server = undefined;
		assertRedacted((await readFile(join(directory, "studio.db"))).toString());
		server = await startStudio(directory, origin.port, false, fixtures.env);
		await page.reload();
		await expect(acceptance).toHaveAttribute("datetime", String(toapisAccepted));
		await selectProvider(page, "Poyo.ai");
		await expect(acceptance).toHaveAttribute("datetime", String(poyoAccepted));
		expect(fixtures.requests.slice(3)).toEqual([
			{ path: "/toapis/models", method: "GET", key: keys.restricted },
			{ path: "/toapis/models", method: "GET", key: keys.toapis },
		]);

		await page.setViewportSize({ width: 320, height: 720 });
		const menu = page.getByRole("button", { name: "Menu", exact: true });
		const drawer = page.getByRole("dialog");
		const closeMenu = drawer.getByRole("button", { name: "Close menu", exact: true });
		await expect(menu).toBeEnabled();
		await menu.press("Enter");
		// Ark UI moves initial focus into the drawer after it becomes visible.
		await expect(closeMenu).toBeFocused();
		await drawer.getByRole("link", { name: "Studio home" }).press("Enter");
		await expect(page.getByRole("heading", { name: "Studio home" })).toBeVisible();
		await expect(drawer).toHaveCount(0);
		await menu.press("Enter");
		await expect(closeMenu).toBeFocused();
		await drawer.getByRole("link", { name: "Settings", exact: true }).press("Enter");
		await expect(page.getByRole("heading", { name: "Provider connections" })).toBeVisible();
		await expect(acceptance).toHaveAttribute("datetime", String(poyoAccepted));

		await server.stop();
		diagnostics.push(server.diagnostics());
		server = undefined;
		await unlink(join(directory, "provider-credentials.key"));
		server = await startStudio(directory, origin.port, false, fixtures.env);
		await page.reload();
		await expect(page.getByText("Reconnect required")).toBeVisible();
		await expect(acceptance).toHaveCount(0);
		await selectProvider(page, "ToAPIs");
		await expect(page.getByText("Reconnect required")).toBeVisible();
		expect(await submit(page, "Remove key")).toBe(200);
		await expect(page.getByRole("status")).toHaveText("Key removed.");
		await expect(page.getByRole("status")).toBeFocused();
		await expect(page.getByText("Disconnected", { exact: true })).toBeVisible();
		await selectProvider(page, "Poyo.ai");
		await expect(page.getByText("Reconnect required")).toBeVisible();
		expect(fixtures.requests).toHaveLength(5);
		expect(await submit(page, "Connect", keys.poyo)).toBe(200);
		await expect(page.getByText("Connected", { exact: true })).toBeVisible();
		expect(fixtures.requests).toHaveLength(6);
		expect(external).toEqual([]);
	} finally {
		if (server) {
			await server.stop();
			diagnostics.push(server.diagnostics());
		}
		await fixtures.stop();
		await rm(directory, { recursive: true, force: true });
	}
	assertRedacted(diagnostics.join("\n"));
});

test("an open Settings page warns before changing a key needed by a new job", async ({ page }) => {
	const directory = await createOwnerDirectory();
	const fixtures = startProviderFixtures(jobResponses());
	let server: Studio | undefined;
	try {
		server = await startStudio(directory, "0", false, fixtures.env);
		await claimStudio(page, server);
		await page.goto(settingsUrl(server));
		await selectProvider(page, "ToAPIs");
		expect(await submit(page, "Connect", keys.toapis)).toBe(200);
		const warning = page.getByText(/Jobs still need this key/);
		await expect(warning).toHaveCount(0);

		const studio = await page.context().newPage();
		await studio.goto(new URL("/image", server.origin).href);
		// "Use example" works only after hydration. The shell enables Menu once its children mount.
		await expect(
			studio.getByRole("button", { name: "Menu", exact: true, includeHidden: true }),
		).toBeEnabled();
		await studio.getByRole("button", { name: "Use example" }).press("Enter");
		await studio.getByRole("button", { name: "Review request", exact: true }).press("Enter");
		await studio.getByRole("checkbox", { name: /unknown cost/i }).check();
		await studio.getByRole("button", { name: "Queue 1 request" }).press("Enter");
		await expect(studio).toHaveURL(/\/jobs/);

		expect(await submit(page, "Replace key", keys.toapis)).toBe(409);
		await expect(warning).toBeVisible();
		for (const name of ["Remove key", "Replace key"]) {
			await expect(page.getByRole("button", { name, exact: true })).toHaveAccessibleDescription(
				/unsaved results/,
			);
		}
		expect(fixtures.requests.filter(({ path }) => path === "/toapis/models")).toHaveLength(1);
		expect(await submit(page, "Remove key")).toBe(200);
		await studio.reload();
		await expect(studio.getByRole("article")).toContainText("original API key");
		await expect(studio.getByRole("button", { name: "Refresh status" })).toHaveCount(0);
	} finally {
		await server?.stop();
		fixtures.stop();
		await rm(directory, { recursive: true, force: true });
	}
});

test("removing a connection while the built server checks a replacement leaves it disconnected", async ({
	page,
}) => {
	const directory = await createOwnerDirectory();
	const fixtures = startProviderFixtures();
	let server: Studio | undefined;
	try {
		server = await startStudio(directory, "0", false, fixtures.env);
		await claimStudio(page, server);
		expect((await postAction(page.request, server, "connect", "poyo", keys.poyo)).status()).toBe(
			200,
		);
		const replacement = postAction(page.request, server, "connect", "poyo", keys.slow);
		try {
			await Promise.race([
				fixtures.slowStarted,
				replacement.then(() => {
					throw new Error("Replacement completed before reaching the delayed fixture.");
				}),
			]);
			expect((await postAction(page.request, server, "connect", "poyo", keys.poyo)).status()).toBe(
				409,
			);
			expect(
				(await postAction(page.request, server, "connect", "toapis", keys.toapis)).status(),
			).toBe(200);
			expect((await postAction(page.request, server, "remove", "poyo")).status()).toBe(200);
		} finally {
			fixtures.releaseSlow();
		}
		const result = await replacement;
		expect(result.status()).toBe(409);
		assertRedacted(await result.text());
		await page.goto(`${settingsUrl(server)}?provider=poyo`);
		await expect(page.getByText("Disconnected", { exact: true })).toBeVisible();
		await selectProvider(page, "ToAPIs");
		await expect(page.getByText("Connected", { exact: true })).toBeVisible();
		expect(fixtures.requests).toEqual([
			{ path: "/poyo/balance", method: "GET", key: keys.poyo },
			{ path: "/poyo/balance", method: "GET", key: keys.slow },
			{ path: "/toapis/models", method: "GET", key: keys.toapis },
		]);
	} finally {
		await server?.stop();
		await fixtures.stop();
		await rm(directory, { recursive: true, force: true });
	}
});

for (const [outcome, key, message] of [
	["accepted", keys.poyo, "Key accepted and saved."],
	["rejected", keys.rejected, "The provider rejected this key."],
	["unavailable", keys.unavailable, "The provider check is unavailable. Try again later."],
] as const) {
	test(`Settings preserves the selected provider and the pending provider’s ${outcome} result`, async ({
		page,
	}) => {
		const directory = await createOwnerDirectory();
		const fixtures = startProviderFixtures();
		const delayed = Promise.withResolvers<void>();
		const deliver = Promise.withResolvers<void>();
		let server: Studio | undefined;
		try {
			server = await startStudio(directory, "0", false, fixtures.env);
			await claimStudio(page, server);
			await page.goto(settingsUrl(server));
			await page.route("**/settings/providers?*/connect&provider=poyo", async (route) => {
				const response = await route.fetch();
				delayed.resolve();
				await deliver.promise;
				await route.fulfill({ response });
			});
			await page.getByLabel("API key").fill(key);
			await page.getByRole("button", { name: "Connect", exact: true }).press("Enter");
			await delayed.promise;
			await expect(page.getByRole("button", { name: "Checking key…" })).toBeFocused();
			await page.getByRole("link", { name: "ToAPIs", exact: true }).click();
			await expect(page.getByLabel("API key")).toBeEnabled();
			expect(await submit(page, "Connect", keys.toapis)).toBe(200);
			await expect(page.getByRole("status")).toHaveText("Key accepted and saved.");
			const finished = page.waitForResponse((response) =>
				key === keys.poyo
					? response.request().method() === "GET" && response.url().includes("__data.json")
					: response.request().method() === "POST" &&
						response.url().includes("/connect&provider=poyo"),
			);
			deliver.resolve();
			await finished;
			await expect(page.getByRole("link", { name: "ToAPIs" })).toHaveAttribute(
				"aria-current",
				"page",
			);
			await expect(page.getByText("Connected", { exact: true })).toBeVisible();
			await page.getByRole("link", { name: "Poyo.ai" }).click();
			await expect(
				page.getByText(key === keys.poyo ? "Connected" : "Disconnected", { exact: true }),
			).toBeVisible();
			await expect(page.getByRole(key === keys.poyo ? "status" : "alert")).toHaveText(message);
		} finally {
			deliver.resolve();
			await server?.stop();
			await fixtures.stop();
			await rm(directory, { recursive: true, force: true });
		}
	});
}
