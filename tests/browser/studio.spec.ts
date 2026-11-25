import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readdir, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { expect } from "@playwright/test";
import { createOwnerDirectory } from "../fixtures/owner-directory";
import { startStudio } from "./built-studio";
import { test } from "./studio-test";

test("one owner can claim the studio and sign in after a process restart", async ({ browser }) => {
	const directory = await createOwnerDirectory();
	const password = randomUUID();
	const owner = await browser.newContext({ colorScheme: "light" });
	let server: Awaited<ReturnType<typeof startStudio>> | undefined;
	try {
		server = await startStudio(directory, "0", true);
		const { origin } = server;
		const page = await owner.newPage();
		await page.goto(origin.href);
		await expect(page).toHaveURL(new URL("/setup", origin).href);
		await expect.poll(server.setupUrl).toBe(page.url());
		const setup = await page.goto(server.setupUrl());
		expect(setup?.headers()["cache-control"]).toBe("no-store");
		await expect.poll(() => Boolean(server?.token())).toBe(true);
		const token = server.token();
		expect(server.announcements()).toBe(1);
		expect((await page.content()).includes(token)).toBe(false);
		const wrongOrigin = await page.request.post(new URL("/owner/challenge", origin).href, {
			headers: { Origin: "http://localhost" },
			data: { purpose: "claim" },
		});
		expect(wrongOrigin.status()).toBe(403);
		expect(await (await page.request.get(new URL("/healthz", origin).href)).json()).toEqual({
			status: "ok",
		});
		expect((await page.request.post(origin.href)).status()).toBe(403);
		expect((await page.request.get(origin.href, { headers: { Host: "localhost" } })).status()).toBe(
			403,
		);
		await page.getByLabel("Claim token").fill(token);
		await page.getByLabel("Username", { exact: true }).fill("studio-owner");
		await page.getByLabel("Password", { exact: true }).fill(password);
		await page.getByRole("button", { name: "Claim studio" }).press("Enter");
		await page.getByRole("link", { name: "Skip for now" }).click();
		await page.getByRole("button", { name: "Continue to studio" }).click();
		await expect(page).toHaveURL(origin.href);
		await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
		// Without JavaScript a page is a public shell: it shows no private data and no studio.
		const scriptless = await browser.newPage({ javaScriptEnabled: false, colorScheme: "dark" });
		try {
			await scriptless.goto(new URL("/jobs", origin).href);
			// The shell carries a <noscript> notice and nothing else.
			expect(await scriptless.content()).toContain("Siluet needs JavaScript");
			await expect(scriptless.locator("main")).toHaveCount(0);
			await expect(scriptless.getByText("studio-owner")).toHaveCount(0);
			await expect(scriptless.getByRole("link", { name: "Jobs", exact: true })).toHaveCount(0);
		} finally {
			await scriptless.close();
		}
		const missing = await page.request.get(new URL("/missing-studio-route", origin).href);
		expect(missing.status()).toBe(404);
		expect(await missing.text()).toContain('name="siluet-installation"');
		// The studio never sets a cookie.
		expect(await owner.cookies()).toEqual([]);
		await page.keyboard.press("Tab");
		await page.keyboard.press("Tab");
		const homeLink = page.getByRole("link", { name: "Studio home" });
		await expect(homeLink).toBeFocused();
		await expect(homeLink).toHaveCSS("outline-color", "rgb(244, 196, 97)");
		await page.getByLabel("Appearance").selectOption("dark");
		await expect(page.locator("html")).toHaveCSS("color-scheme", "dark");
		await expect(page.locator("html")).toHaveCSS("background-color", "rgb(21, 30, 46)");
		await page.setViewportSize({ width: 320, height: 720 });
		await page.getByRole("button", { name: "Menu", exact: true }).click();
		await expect(page.getByRole("dialog")).toBeVisible();
		await page.keyboard.press("Escape");
		await expect(page.getByRole("button", { name: "Menu", exact: true })).toBeFocused();
		await page.emulateMedia({ colorScheme: "dark" });
		await page.getByLabel("Appearance").selectOption("light");
		await expect(page.locator("html")).toHaveCSS("color-scheme", "light");
		await expect(page.locator("html")).toHaveCSS("background-color", "rgb(242, 245, 250)");
		await server.stop();
		server = undefined;
		server = await startStudio(directory, origin.port);
		// The browser key resumes its stored session after a restart.
		await page.reload();
		await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
		await expect(page.locator("html")).toHaveCSS("background-color", "rgb(242, 245, 250)");
		// A signed-in tab opening the sign-in page lands in the studio.
		await page.goto(new URL("/sign-in", origin).href);
		await expect(page).toHaveURL(origin.href);
		await page.getByRole("button", { name: "Sign out" }).click();
		await expect(page).toHaveURL(new URL("/sign-in", origin).href);
		await page.goto(origin.href);
		await expect(page).toHaveURL(new URL("/sign-in", origin).href);
		const fresh = await browser.newContext();
		try {
			const revisit = await fresh.newPage();
			await revisit.goto(origin.href);
			await expect(revisit).toHaveURL(new URL("/sign-in", origin).href);
			const denied = await fresh.request.post(new URL("/jobs?/lookup", origin).href, {
				headers: { Origin: origin.origin },
				maxRedirects: 0,
			});
			expect(denied.status()).toBe(401);
			expect(denied.headers()["cache-control"]).toBe("no-store");
			const repeat = await fresh.request.post(new URL("/owner/claim", origin).href, {
				headers: { Origin: origin.origin },
				data: { token, username: "other", password },
			});
			expect(repeat.status()).toBe(403);
			expect(server.announcements()).toBe(0);
			// Client navigation to a claimed /setup finds nothing.
			await revisit.evaluate(() => {
				const link = document.createElement("a");
				link.href = "/setup";
				link.textContent = "setup";
				document.body.append(link);
			});
			await revisit.getByRole("link", { name: "setup" }).click();
			await expect(revisit.getByLabel("Claim token")).toHaveCount(0);
			await expect(revisit.getByRole("heading", { name: "Not found" })).toBeVisible();
			await revisit.goto(origin.href);
			await expect(revisit).toHaveURL(new URL("/sign-in", origin).href);
			await revisit.getByLabel("Username", { exact: true }).fill("studio-owner");
			await revisit.getByLabel("Password", { exact: true }).fill("incorrect");
			await revisit.getByRole("button", { name: "Sign in" }).click();
			await expect(revisit.getByRole("alert")).toBeFocused();
			await expect(revisit.getByLabel("Username", { exact: true })).toHaveValue("studio-owner");
			await expect(revisit.getByLabel("Password", { exact: true })).toHaveValue("");
			await revisit.getByLabel("Password", { exact: true }).fill(password);
			await revisit.getByRole("button", { name: "Sign in" }).click();
			await expect(revisit.getByRole("button", { name: "Sign out" })).toBeVisible();
		} finally {
			await fresh.close();
		}
		await server.stop();
		server = undefined;
		await unlink(join(directory, "studio.db"));
		await expect(startStudio(directory, origin.port)).rejects.toThrow("Studio stopped");
	} finally {
		await server?.stop();
		await owner.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("a direct built-server invocation explains the required launcher before opening storage", async () => {
	const directory = await mkdtemp(join(tmpdir(), "siluet-direct-start-"));
	try {
		const processHandle = spawn("bun", ["build/index.js"], {
			env: {
				...process.env,
				SILUET_SERVER_PORT: "3000",
				SILUET_SERVER_ORIGIN: "http://127.0.0.1:3000",
				SILUET_DATA_DIR: directory,
			},
			stdio: ["ignore", "ignore", "pipe"],
			timeout: 8000,
		});
		let launcherHint = false;
		const lines = createInterface({ input: processHandle.stderr });
		lines.on("line", (line) => {
			if (line.includes("Start Siluet with bun run start.")) launcherHint = true;
		});
		const [code] = await once(processHandle, "close");
		expect(code).toBe(1);
		expect(launcherHint).toBe(true);
		expect(await readdir(directory)).toEqual([]);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
