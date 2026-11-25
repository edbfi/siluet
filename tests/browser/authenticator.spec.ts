import { chmod, readdir, rm, unlink } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Page } from "@playwright/test";
import { TOTP } from "otpauth";
import decodeQR from "qr/decode.js";
import sharp from "sharp";
import { createOwnerDirectory } from "../fixtures/owner-directory";
import { createOwnerClient } from "../owner-client";
import { startStudio } from "./built-studio";
import { claimOwner, ownerRequest, signInOwner } from "./owner-session";
import { test } from "./studio-test";

async function interruptKeyRead(directory: string) {
	const name = (await readdir(directory)).find((entry) => /^factor-.*[.]key$/.test(entry));
	if (!name) throw new Error("Missing fixture key.");
	const path = join(directory, name);
	await chmod(path, 0);
	return () => chmod(path, 0o600);
}

async function candidate(page: Page, password: string) {
	await page.getByLabel("Current password").fill(password);
	await page.getByRole("button", { name: "Set up authenticator" }).click();
	const manual = (await page.locator("section code").first().textContent()) ?? "";
	const src = await page.getByAltText("Authenticator setup QR code").getAttribute("src");
	if (!src?.startsWith("data:image/gif;base64,")) throw new Error("Expected a locally encoded QR.");
	const { data, info } = await sharp(Buffer.from(src.split(",")[1], "base64"))
		.resize(360, 360, { kernel: "nearest" })
		.ensureAlpha()
		.raw()
		.toBuffer({ resolveWithObject: true });
	const uri = new URL(decodeQR({ data, width: info.width, height: info.height }));
	expect(uri.protocol).toBe("otpauth:");
	expect(uri.hostname).toBe("totp");
	expect(uri.searchParams.get("issuer")).toBe("Siluet");
	expect(uri.searchParams.get("secret") === manual).toBe(true);
	return new TOTP({ secret: manual });
}
const dialogCodes = (page: Page) => page.getByRole("dialog").locator("li");
async function savedCodes(page: Page) {
	await expect(dialogCodes(page)).toHaveCount(10);
	const done = page.getByRole("dialog").getByRole("button", { name: "Done" });
	await expect(done).toBeFocused();
	const codes = await dialogCodes(page).allTextContents();
	await done.click();
	await expect(page.getByRole("dialog")).toHaveCount(0);
	return codes;
}

test("owner can enroll, finish sign-in with a factor and make each Security change", async ({
	browser,
}) => {
	test.setTimeout(150000);
	const directory = await createOwnerDirectory(),
		server = await startStudio(directory);
	const owner = await browser.newContext({
		viewport: { width: 360, height: 740 },
		colorScheme: "light",
	});
	const page = await owner.newPage(),
		origin = server.origin.origin,
		password = crypto.randomUUID();
	const other = await browser.newContext();
	try {
		await page.goto(origin);
		await expect.poll(server.token).not.toBe("");
		await page.getByLabel("Claim token").fill(server.token());
		await page.getByLabel("Username").fill("owner");
		await page.getByLabel("Password", { exact: true }).fill(password);
		await page.getByRole("button", { name: "Claim studio" }).click();
		await expect(page.getByRole("link", { name: "Skip for now" })).toBeVisible();
		const security = `${origin}/settings/security`;
		await page.getByRole("link", { name: "Skip for now" }).click();
		await page.goto(security);
		await expect(page.getByAltText("Authenticator setup QR code")).toHaveCount(0);
		// Another browser signs in for itself before the change.
		const elsewhere = await other.newPage();
		await signInOwner(elsewhere, origin, password, "owner");
		await elsewhere.goto(`${origin}/jobs`);
		await expect(elsewhere.getByRole("heading", { name: "No jobs yet" })).toBeVisible();
		await page.getByLabel("Current password").fill("incorrect");
		await page.getByRole("button", { name: "Set up authenticator" }).click();
		await expect(page.getByRole("alert")).toBeVisible();
		const totp = await candidate(page, password);
		await expect(page.getByRole("heading", { name: "Connect your authenticator" })).toBeFocused();
		await page.getByLabel("New authenticator code").fill(totp.generate({ timestamp: Date.now() }));
		await page.getByRole("button", { name: "Confirm authenticator" }).click();
		await expect(dialogCodes(page)).toHaveCount(10);
		// The codes stay readable while the other browser's next check finds its session gone.
		await elsewhere.evaluate(() => window.dispatchEvent(new Event("focus")));
		await expect(elsewhere).toHaveURL(`${origin}/sign-in`);
		// A new protected request on the rotated session succeeds.
		expect((await ownerRequest(page).get(`${origin}/jobs/__data.json`)).status()).toBe(200);
		const codes = await savedCodes(page);
		await expect(page.getByRole("status")).toContainText("Security updated");
		const signout = async () => {
			await page.goto(origin);
			await page.getByRole("button", { name: "Sign out" }).click();
			await expect(page).toHaveURL(`${origin}/sign-in`);
		};
		const primary = async () => {
			await page.getByLabel("Username").fill("owner");
			await page.getByLabel("Password", { exact: true }).fill(password);
			await page.getByRole("button", { name: "Sign in" }).click();
			await expect(page.getByRole("heading", { name: "Verify your sign-in" })).toBeVisible();
		};
		for (const recovery of [false, true]) {
			await signout();
			await primary();
			// A pending sign-in is page memory only: no cookie and no private access.
			expect(await owner.cookies()).toEqual([]);
			for (const path of ["/jobs/__data.json", "/__data.json", "/gallery/fixture/media"])
				expect((await page.request.get(origin + path, { maxRedirects: 0 })).status()).toBe(401);
			expect(
				(
					await page.request.post(`${origin}/image/queue`, {
						headers: { Origin: origin },
						maxRedirects: 0,
					})
				).status(),
			).toBe(401);
			await page
				.getByLabel("Authenticator or recovery code")
				.fill(recovery ? codes[0] : totp.generate({ timestamp: Date.now() + 30000 }));
			await page.getByRole("button", { name: "Verify code" }).click();
			await expect(page).toHaveURL(`${origin}/`);
		}
		async function change(action: string, code: string) {
			await page.goto(security);
			await page.getByLabel("Current password").fill(password);
			await page.getByLabel("Authenticator or recovery code").fill(code);
			await page.getByLabel("Security action").selectOption(action);
			await page.getByRole("button", { name: "Continue" }).click();
		}
		await change("regenerate", codes[1]);
		const regenerated = await savedCodes(page);
		await change("replace", codes[2]);
		await expect(page.getByRole("alert")).toBeVisible();
		await change("replace", regenerated[0]);
		const replacement = new TOTP({
			secret: (await page.locator("section code").first().textContent()) ?? "",
		});
		await page.getByLabel("New authenticator code").fill(replacement.generate());
		await page.getByRole("button", { name: "Confirm authenticator" }).click();
		const replaced = await savedCodes(page);
		await change("disable", regenerated[1]);
		await expect(page.getByRole("alert")).toBeVisible();
		// Turning the authenticator off issues no codes: a banner sits above the refreshed form.
		await change("disable", replaced[0]);
		const banner = page.getByRole("status").filter({ hasText: "Security updated" });
		await expect(banner).toBeVisible();
		await expect(page.getByRole("dialog")).toHaveCount(0);
		const setUp = page.getByRole("button", { name: "Set up authenticator" });
		await expect(setUp).toBeVisible();
		expect(
			await banner.evaluate(
				(node, button) =>
					Boolean(node.compareDocumentPosition(button as Node) & Node.DOCUMENT_POSITION_FOLLOWING),
				await setUp.elementHandle(),
			),
		).toBe(true);
		const again = await candidate(page, password);
		await page.getByLabel("New authenticator code").fill(again.generate());
		await page.getByRole("button", { name: "Confirm authenticator" }).click();
		const enrolled = await savedCodes(page);
		await change("replace", enrolled[0]);
		const next = new TOTP({
			secret: (await page.locator("section code").first().textContent()) ?? "",
		});
		const proof = await page.locator('input[name="proof"]').inputValue();
		// Fill this fixture's rolling window, then submit a correct code from the page.
		for (let i = 0; i < 5; i++) {
			const response = await ownerRequest(page).post(security, {
				form: { change: "replace", proof, code: "invalid" },
				headers: { Origin: origin, accept: "text/html" },
			});
			if (response.status() === 429) break;
			expect(response.status()).toBe(403);
		}
		await page.getByLabel("New authenticator code").fill(next.generate());
		await page.getByRole("button", { name: "Confirm authenticator" }).click();
		await expect(page.getByRole("alert")).toContainText("Retry in");
		await expect(page.getByLabel("New authenticator code")).toBeVisible();
		expect((await page.locator('input[name="proof"]').inputValue()) === proof).toBe(true);
		await expect(page.getByLabel("Current password")).toHaveCount(0);
		const active = (await readdir(directory)).find((name) => /^factor-.*[.]key$/.test(name));
		if (!active) throw new Error("Active key missing.");
		await unlink(join(directory, active));
		for (const path of ["/jobs", "/jobs/__data.json", "/gallery/fixture/media", "/image/queue"]) {
			const response =
				path === "/image/queue"
					? await page.request.post(origin + path, { headers: { Origin: origin } })
					: await page.request.get(origin + path);
			expect(response.status()).toBe(503);
			expect(await response.text()).toContain("owner:recover");
		}
	} finally {
		await other.close();
		await owner.close();
		await server.stop();
		await rm(directory, { recursive: true, force: true });
	}
});

test("storage that is temporarily unreadable offers Retry, and the candidate resumes after it", async ({
	page,
}) => {
	test.setTimeout(90000);
	const directory = await createOwnerDirectory(),
		server = await startStudio(directory);
	const origin = server.origin.origin,
		password = crypto.randomUUID();
	try {
		await claimOwner(page, server, password, "owner");
		await page.goto(`${origin}/settings/security`);
		const totp = await candidate(page, password);
		await page.getByLabel("New authenticator code").fill(totp.generate());
		await page.getByRole("button", { name: "Confirm authenticator" }).click();
		const codes = await savedCodes(page);
		await page.goto(`${origin}/settings/security`);
		await page.getByLabel("Current password").fill(password);
		await page.getByLabel("Authenticator or recovery code").fill(codes[0]);
		await page.getByLabel("Security action").selectOption("replace");
		await page.getByRole("button", { name: "Continue" }).click();
		const replacement = new TOTP({
			secret: (await page.locator("section code").first().textContent()) ?? "",
		});
		const restore = await interruptKeyRead(directory);
		try {
			await page.getByLabel("New authenticator code").fill(replacement.generate());
			await page.getByRole("button", { name: "Confirm authenticator" }).click();
			await expect(page.getByRole("heading", { name: "Studio access" })).toBeVisible();
			await expect(page.getByRole("link", { name: "Retry" })).toBeVisible();
			await expect(page.locator('input[name="proof"]')).toHaveCount(0);
		} finally {
			await restore();
		}
		await page.getByRole("link", { name: "Retry" }).click();
		await page.getByRole("link", { name: "Resume authenticator setup" }).click();
		await expect(page.getByLabel("Current password")).toHaveCount(0);
		await page.getByLabel("New authenticator code").fill(replacement.generate());
		await page.getByRole("button", { name: "Confirm authenticator" }).click();
		await savedCodes(page);
	} finally {
		await server.stop();
		await rm(directory, { recursive: true, force: true });
	}
});

test("the built server on an independent loopback port and the interactive recovery command exclude each other", async ({
	request,
}) => {
	test.setTimeout(90000);
	const directory = await createOwnerDirectory();
	let server = await startStudio(directory);
	let serving = true;
	const recover = (waiting: boolean) => {
		let text = "";
		const ready = Promise.withResolvers<void>();
		const child = Bun.spawn([process.execPath, "run", "owner:recover"], {
			env: { ...process.env, SILUET_DATA_DIR: directory },
			terminal: {
				cols: 150,
				rows: 25,
				data(_, bytes) {
					text += Buffer.from(bytes).toString();
					if (text.includes("New password:")) ready.resolve();
				},
			},
		});
		if (waiting)
			void child.exited.then(() =>
				ready.reject(new Error("Recovery exited before acquiring the lock.")),
			);
		return { child, ready: ready.promise, output: () => text };
	};
	try {
		await expect.poll(server.token).not.toBe("");
		const client = await createOwnerClient(server.origin.origin);
		await client.claim(server.token(), "owner", crypto.randomUUID());
		await expect(startStudio(directory)).rejects.toThrow("Studio stopped");
		const refused = recover(false);
		try {
			expect(await refused.child.exited).toBe(1);
			expect(refused.output()).not.toContain("New password:");
		} finally {
			refused.child.terminal?.close();
		}
		await server.stop();
		serving = false;
		const exclusive = recover(true);
		try {
			await exclusive.ready;
			await expect(startStudio(directory)).rejects.toThrow("Studio stopped");
			exclusive.child.terminal?.write("\x03");
			expect(await exclusive.child.exited).toBe(1);
		} finally {
			exclusive.child.kill();
			exclusive.child.terminal?.close();
		}
		server = await startStudio(directory);
		serving = true;
		expect(
			(await request.get(new URL("/jobs", server.origin).href, { maxRedirects: 0 })).status(),
		).toBe(200);
	} finally {
		if (serving) await server.stop();
		await rm(directory, { recursive: true, force: true });
	}
});

test("a reload during a pending sign-in restarts sign-in", async ({ page }) => {
	const directory = await createOwnerDirectory();
	const studio = await startStudio(directory);
	try {
		const origin = studio.origin.origin;
		const password = crypto.randomUUID();
		await claimOwner(page, studio, password, "owner");
		await page.goto(`${origin}/settings/security`);
		const totp = await candidate(page, password);
		await page.getByLabel("New authenticator code").fill(totp.generate());
		await page.getByRole("button", { name: "Confirm authenticator" }).click();
		await savedCodes(page);
		await page.goto(origin);
		await page.getByRole("button", { name: "Sign out" }).click();
		await page.getByLabel("Username").fill("owner");
		await page.getByLabel("Password", { exact: true }).fill(password);
		await page.getByRole("button", { name: "Sign in" }).click();
		await expect(page.getByRole("heading", { name: "Verify your sign-in" })).toBeVisible();
		await page.reload();
		await expect(page.getByRole("heading", { name: "Welcome back" })).toBeVisible();
		await expect(page.getByRole("alert")).toHaveText(
			"Sign-in restarted. Enter your username and password again.",
		);
		// Cancel spends nothing and returns to the password step.
		await page.getByLabel("Username").fill("owner");
		await page.getByLabel("Password", { exact: true }).fill(password);
		await page.getByRole("button", { name: "Sign in" }).click();
		await page.getByRole("button", { name: "Cancel" }).click();
		await expect(page.getByRole("heading", { name: "Welcome back" })).toBeVisible();
	} finally {
		await studio.stop();
		await rm(directory, { recursive: true, force: true });
	}
});
