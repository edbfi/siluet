import { chmod, readdir, rm, unlink } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { TOTP } from "otpauth";
import decodeQR from "qr/decode.js";
import sharp from "sharp";
import { createOwnerDirectory } from "../fixtures/owner-directory";
import { startStudio } from "./built-studio";

async function interruptKeyRead(directory: string) {
	const name = (await readdir(directory)).find((entry) => /^factor-.*[.]key$/.test(entry));
	if (!name) throw new Error("Missing fixture key.");
	const path = join(directory, name);
	if (process.platform !== "win32") {
		await chmod(path, 0);
		return () => chmod(path, 0o600);
	}
	const child = Bun.spawn(
		[
			"powershell.exe",
			"-NoProfile",
			"-NonInteractive",
			"-Command",
			"$ErrorActionPreference='Stop'; $f=[IO.File]::Open($env:SILUET_FIXTURE_KEY,'Open','Read','None'); [Console]::WriteLine('held'); [Console]::ReadLine() | Out-Null; $f.Dispose()",
		],
		{
			env: { ...process.env, SILUET_FIXTURE_KEY: path },
			stdin: "pipe",
			stdout: "pipe",
			stderr: "ignore",
		},
	);
	const reader = child.stdout.getReader();
	try {
		const first = await reader.read();
		if (!new TextDecoder().decode(first.value).includes("held"))
			throw new Error("Missing native sharing lock.");
	} catch (e) {
		child.kill();
		await child.exited;
		throw e;
	} finally {
		reader.releaseLock();
	}
	return async () => {
		child.stdin.end();
		await child.exited;
	};
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
for (const javascript of [true, false]) {
	test(`owner can enroll and finish sign-in with scripting ${javascript ? "on" : "off"}`, async ({
		browser,
	}) => {
		test.setTimeout(100000);
		const directory = await createOwnerDirectory(),
			server = await startStudio(directory);
		const owner = await browser.newContext({
			javaScriptEnabled: javascript,
			viewport: { width: 360, height: 740 },
			colorScheme: javascript ? "light" : "dark",
		});
		const page = await owner.newPage(),
			origin = server.origin.origin,
			password = crypto.randomUUID();
		try {
			await page.goto(origin);
			await expect.poll(server.token).not.toBe("");
			await page.getByLabel("Claim token").fill(server.token());
			await page.getByLabel("Username").fill("owner");
			await page.getByLabel("Password", { exact: true }).fill(password);
			await page.getByRole("button", { name: "Claim studio" }).click();
			await expect(page.getByRole("link", { name: "Skip for now" })).toBeVisible();
			const security = `${origin}/settings/security`;
			if (javascript) {
				await page.getByRole("link", { name: "Skip for now" }).click();
				await page.goto(security);
			}
			await expect(page.getByAltText("Authenticator setup QR code")).toHaveCount(0);
			const previous = await owner.storageState();
			await page.getByLabel("Current password").fill("incorrect");
			await page.getByRole("button", { name: "Set up authenticator" }).click();
			await expect(page.getByRole("alert")).toBeVisible();
			const totp = await candidate(page, password);
			if (javascript)
				await expect(
					page.getByRole("heading", { name: "Connect your authenticator" }),
				).toBeFocused();
			if (process.platform === "win32")
				await expect(page.getByText("bun run owner:recover", { exact: true })).toBeVisible();
			await page
				.getByLabel("New authenticator code")
				.fill(totp.generate({ timestamp: Date.now() }));
			const other = await browser.newContext({ storageState: previous });
			try {
				await page.getByRole("button", { name: "Confirm authenticator" }).click();
				await expect(page.locator("section li")).toHaveCount(10);
				if (javascript)
					await expect(
						page.getByRole("heading", { name: "Save your recovery codes" }),
					).toBeFocused();
				const codes = await page.locator("section li").allTextContents();
				const stale = await other.request.get(`${origin}/jobs`, { maxRedirects: 0 });
				expect(stale.status()).toBe(303);
				expect(stale.headers().location).toBe("/sign-in");
				expect(stale.headers()["set-cookie"]).toContain("siluet_security_");
				expect((stale.headers()["set-cookie"] ?? "").includes("HttpOnly")).toBe(false);
				expect((await page.request.get(`${origin}/jobs`, { maxRedirects: 0 })).status()).toBe(200);
				await expect(page.locator("section li")).toHaveCount(10);
				await page.getByRole("link", { name: "Done" }).click();
				await expect(page.locator("section li")).toHaveCount(0);
				const signout = async () => {
					await page.goto(origin);
					await page.getByRole("button", { name: "Sign out" }).click();
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
					const pending = (await owner.cookies()).filter((c) => c.name.includes("_pending_"));
					expect(pending.length).toBe(1);
					const [credential] = pending;
					expect(credential.path).toBe("/sign-in");
					expect(credential.httpOnly).toBe(true);
					expect(credential.sameSite).toBe("Lax");
					for (const path of ["/", "/jobs", "/gallery/fixture/media"]) {
						expect((await page.request.get(origin + path, { maxRedirects: 0 })).status()).toBe(303);
					}
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
					expect((await owner.cookies()).some((c) => c.name === credential.name)).toBe(false);
				}
				async function change(action: string, code: string) {
					await page.goto(security);
					await page.getByLabel("Current password").fill(password);
					await page.getByLabel("Authenticator or recovery code").fill(code);
					await page.getByLabel("Security action").selectOption(action);
					await page.getByRole("button", { name: "Continue" }).click();
				}
				await change("regenerate", codes[1]);
				await expect(page.locator("section li")).toHaveCount(10);
				const regenerated = await page.locator("section li").allTextContents();
				await change("replace", codes[2]);
				await expect(page.getByRole("alert")).toBeVisible();
				if (!javascript) {
					for (const code of regenerated.slice(0, 9)) {
						const authorization = await page.request.post(security, {
							form: { change: "replace", password, code },
							headers: { Origin: origin, accept: "text/html" },
						});
						expect(authorization.status()).toBe(200);
					}
				}
				await change("replace", javascript ? regenerated[0] : regenerated[9]);
				const replacement = new TOTP({
					secret: (await page.locator("section code").first().textContent()) ?? "",
				});
				if (!javascript) {
					const restore = await interruptKeyRead(directory);
					try {
						await page.getByLabel("New authenticator code").fill(replacement.generate());
						await page.getByRole("button", { name: "Confirm authenticator" }).click();
						await expect(page.getByRole("heading", { name: "Studio access" })).toBeVisible();
						await expect(page.getByRole("link", { name: "Retry" })).toHaveAttribute(
							"href",
							"/settings/security?resume",
						);
						await expect(page.locator('input[name="proof"]')).toHaveCount(0);
					} finally {
						await restore();
					}
					await page.getByRole("link", { name: "Retry" }).click();
					await expect(page.getByLabel("Current password")).toHaveCount(0);
					await expect(page.getByLabel("New authenticator code")).toBeVisible();
				}
				await page.getByLabel("New authenticator code").fill(replacement.generate());
				await page.getByRole("button", { name: "Confirm authenticator" }).click();
				await expect(page.locator("section li")).toHaveCount(10);
				const replaced = await page.locator("section li").allTextContents();
				await change("disable", regenerated[1]);
				await expect(page.getByRole("alert")).toBeVisible();
				if (javascript) {
					await change("replace", replaced[0]);
					const next = new TOTP({
						secret: (await page.locator("section code").first().textContent()) ?? "",
					});
					const proof = await page.locator('input[name="proof"]').inputValue();
					// Fill this fixture's rolling window, then submit a correct code from the page.
					for (let i = 0; i < 5; i++) {
						const response = await page.request.post(security, {
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
					for (const path of ["/jobs", "/gallery/fixture/media", "/image/queue"]) {
						const response =
							path === "/image/queue"
								? await page.request.post(origin + path, { headers: { Origin: origin } })
								: await page.request.get(origin + path);
						expect(response.status()).toBe(503);
						expect(await response.text()).toContain("owner:recover");
					}
				} else {
					await change("disable", replaced[0]);
					await page.getByRole("link", { name: "Done" }).click();
					await expect(page.getByRole("button", { name: "Set up authenticator" })).toBeVisible();
				}
			} finally {
				await other.close();
			}
		} finally {
			await owner.close();
			await server.stop();
			await rm(directory, { recursive: true, force: true });
		}
	});
}

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
		const response = await request.post(new URL("/setup", server.origin).href, {
			form: { token: server.token(), username: "owner", password: crypto.randomUUID() },
			headers: { Origin: server.origin.origin, accept: "text/html" },
			maxRedirects: 0,
		});
		expect(response.status()).toBe(303);
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

test("a username entered while the sign-in page is loading survives hydration", async ({
	page,
}) => {
	const directory = await createOwnerDirectory();
	const studio = await startStudio(directory);
	const resume = Promise.withResolvers<void>();
	try {
		const origin = studio.origin.origin;
		const password = crypto.randomUUID();
		await expect.poll(studio.token).not.toBe("");
		const claimed = await page.request.post(origin + "/setup", {
			headers: { origin, accept: "text/html" },
			form: { token: studio.token(), username: "owner", password },
			maxRedirects: 0,
		});
		expect(claimed.status()).toBe(303);
		await page.context().clearCookies();
		await page.addInitScript(() => localStorage.setItem("siluet-appearance", "dark"));
		await page.route("**/_app/**/*.js", async (route) => {
			await resume.promise;
			await route.continue();
		});
		await page.goto(origin + "/sign-in", { waitUntil: "commit" });
		const username = page.getByLabel("Username");
		await username.fill("owner");
		await page.getByLabel("Password", { exact: true }).fill(password);
		resume.resolve();
		await expect(page.locator("html")).toHaveAttribute("data-appearance", "dark");
		await expect(username).toHaveValue("owner");
		await page.getByRole("button", { name: "Sign in" }).click();
		await expect(page).toHaveURL(origin + "/");
	} finally {
		resume.resolve();
		await studio.stop();
		await rm(directory, { recursive: true, force: true });
	}
});
