import { fork, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readdir, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { expect, test } from "@playwright/test";
import { createOwnerDirectory } from "../fixtures/owner-directory";

async function startStudio(directory: string, port = "0", collide = false) {
	const processHandle = fork(collide ? "tests/browser/occupied-port.ts" : "scripts/start.ts", [], {
		execPath: process.execPath,
		execArgv: ["--preload", join(process.cwd(), "tests/browser/launcher-control.ts")],
		cwd: process.cwd(),
		env: { ...process.env, SILUET_DATA_DIR: directory, SILUET_SERVER_PORT: port },
		stdio: ["ignore", "pipe", "ignore", "ipc"],
	});
	if (!processHandle.stdout) throw new Error("Missing studio output.");
	const closed = once(processHandle, "close");
	const lines = createInterface({ input: processHandle.stdout });
	const listening = Promise.withResolvers<URL>();
	let token = "";
	let announcements = 0;
	let setupUrl = "";
	lines.on("line", (line) => {
		const address = /^Listening on (http:\/\/127\.0\.0\.1:\d+)\/?$/.exec(line);
		if (address) listening.resolve(new URL(address[1]));
		if (line.startsWith("Claim token: ")) {
			announcements++;
			token = line.slice("Claim token: ".length);
		}
		if (line.startsWith("Setup URL: ")) setupUrl = line.slice("Setup URL: ".length);
	});
	const timer = setTimeout(
		() => listening.reject(new Error("Missing listener announcement")),
		10000,
	);
	const stop = async (expectClean = true) => {
		if (processHandle.connected) {
			processHandle.send("stop", () => {});
		}
		const [code] = await closed;
		lines.close();
		if (expectClean) expect(code).toBe(0);
	};
	try {
		const origin = await Promise.race([
			listening.promise,
			closed.then(() => {
				if (announcements) throw new Error("Setup was announced before failed startup.");
				throw new Error("Studio stopped before it was ready");
			}),
		]);
		return {
			origin,
			announcements: () => announcements,
			token: () => token,
			setupUrl: () => setupUrl,
			stop,
		};
	} catch (error) {
		await stop(false);
		throw error;
	} finally {
		clearTimeout(timer);
	}
}

test("one owner can claim the studio and sign in after a process restart", async ({ browser }) => {
	const directory = await createOwnerDirectory();
	const password = randomUUID();
	const owner = await browser.newContext();
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
		const wrongOrigin = await page.request.post(server.setupUrl(), {
			headers: { Origin: "http://localhost" },
			form: { token, username: "other", password },
		});
		expect(wrongOrigin.status()).toBe(403);
		expect((await wrongOrigin.text()).includes(token)).toBe(false);
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
		await expect(page).toHaveURL(origin.href);
		await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
		const cookies = await owner.cookies();
		expect(
			cookies.map(({ httpOnly, sameSite, path, secure }) => ({ httpOnly, sameSite, path, secure })),
		).toContainEqual({ httpOnly: true, sameSite: "Lax", path: "/", secure: false });
		await page.keyboard.press("Tab");
		await page.keyboard.press("Tab");
		const homeLink = page.getByRole("link", { name: "Studio home" });
		await expect(homeLink).toBeFocused();
		await expect(homeLink).toHaveCSS("outline-color", "rgb(244, 196, 97)");
		await page.getByLabel("Appearance").selectOption("dark");
		await expect(page.locator("html")).toHaveCSS("color-scheme", "dark");
		await page.setViewportSize({ width: 320, height: 720 });
		await page.getByRole("button", { name: "Menu", exact: true }).click();
		await expect(page.getByRole("dialog")).toBeVisible();
		await page.keyboard.press("Escape");
		await expect(page.getByRole("button", { name: "Menu", exact: true })).toBeFocused();
		await page.getByLabel("Appearance").selectOption("light");
		await expect(page.locator("html")).toHaveCSS("color-scheme", "light");
		await server.stop();
		server = undefined;
		server = await startStudio(directory, origin.port);
		await page.reload();
		await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
		await page.getByRole("button", { name: "Sign out" }).click();
		await page.goto(origin.href);
		await expect(page).toHaveURL(new URL("/sign-in", origin).href);
		const fresh = await browser.newContext();
		try {
			await fresh.addCookies(cookies);
			const revisit = await fresh.newPage();
			await revisit.goto(origin.href);
			await expect(revisit).toHaveURL(new URL("/sign-in", origin).href);
			const denied = await fresh.request.post(origin.href, {
				headers: { Origin: origin.origin },
				maxRedirects: 0,
			});
			expect(denied.status()).toBe(401);
			expect(denied.headers()["cache-control"]).toBe("no-store");
			const repeat = await fresh.request.post(new URL("/setup", origin).href, {
				headers: { Origin: origin.origin },
				form: { token, username: "other", password },
				maxRedirects: 0,
			});
			expect(repeat.status()).toBe(404);
			expect(server.announcements()).toBe(0);
			await revisit.goto(new URL("/setup", origin).href);
			await expect(revisit.getByLabel("Claim token")).toHaveCount(0);
			await revisit.goto(origin.href);
			await expect(revisit).toHaveURL(new URL("/sign-in", origin).href);
			await revisit.getByLabel("Username", { exact: true }).fill("studio-owner");
			await revisit.getByLabel("Password", { exact: true }).fill("incorrect");
			await revisit.getByRole("button", { name: "Sign in" }).click();
			await expect(revisit.getByRole("alert")).toBeFocused();
			await revisit.getByLabel("Username", { exact: true }).fill("studio-owner");
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
