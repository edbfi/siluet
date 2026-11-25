import { rm } from "node:fs/promises";
import { expect, type Page, test } from "@playwright/test";
import { h3MaxOperation } from "../../src/lib/shared/media-catalog/registry";
import { createOwnerDirectory } from "../fixtures/owner-directory";
import { providerFixtureKeys, startProviderFixtures } from "../fixtures/provider-connections";
import { writeReviewPricing } from "../fixtures/review-pricing";
import {
	h3Acknowledgement,
	h3Finished,
	h3Rate,
	h3ResultUrl,
	h3Task,
} from "../fixtures/video/poyo-h3";
import { h3MaxShape } from "../fixtures/video/real-clips";
import { startStudio } from "./built-studio";
import { seekThenPlay } from "./saved-video-playback";

type Studio = Awaited<ReturnType<typeof startStudio>>;
const prompt = "Waves move past a painted pier.";
const h3Draft = { prompt, duration: 5, resolution: "768p", aspect_ratio: "16:9" };
const h3Input = {
	draft: h3Draft,
	operationKey: h3MaxOperation.key,
	count: 1,
	retryLimit: 0,
	acceptTerms: false,
};

async function signInWithPoyo(page: Page, server: Studio, password = crypto.randomUUID()) {
	const { origin } = server.origin;
	await expect.poll(server.token).not.toBe("");
	for (const [path, form] of [
		["/setup", { token: server.token(), username: "creator", password }],
		["/settings/providers?/connect", { provider: "poyo", key: providerFixtureKeys.poyo }],
	] as const) {
		const response = await page.request.post(origin + path, {
			headers: { origin, accept: "text/html" },
			form,
		});
		expect(response.ok()).toBe(true);
	}
	return password;
}

function poyoFixtures(bytes: Uint8Array<ArrayBuffer>, counts: { posts: number }) {
	return startProviderFixtures(async (request, path) => {
		if (path === "/poyo/submit") {
			counts.posts++;
			expect(request.headers.get("authorization")).toBe(`Bearer ${providerFixtureKeys.poyo}`);
			expect(await request.json()).toEqual({
				model: "h3-max",
				input: { ...h3Draft, enable_safety_checker: false },
			});
			return h3Acknowledgement();
		}
		if (path === `/poyo/status/${h3Task}`) return h3Finished();
		if (path === "/media/video") {
			expect(request.headers.has("authorization")).toBe(false);
			expect(request.headers.has("cookie")).toBe(false);
			return new Response(bytes);
		}
		return null;
	});
}

test("model switch keeps prompt, clears consent, and a Poyo-only owner saves one H3 clip for offline playback", async ({
	page,
	browser,
}) => {
	test.setTimeout(120_000);
	const directory = await createOwnerDirectory();
	const cache = await createOwnerDirectory();
	// A clip laid out like H3 Max output, with its C2PA box.
	const bytes = h3MaxShape();
	const counts = { posts: 0 };
	const fixture = poyoFixtures(bytes, counts);
	let server: Studio | undefined;
	try {
		await writeReviewPricing(cache, 0, undefined, { "h3-max": h3Rate });
		const env = { ...fixture.env, XDG_CACHE_HOME: cache };
		server = await startStudio(directory, "0", false, env);
		const { origin, port } = server.origin;
		await signInWithPoyo(page, server);
		const post = (path: string, data: unknown, from = origin) =>
			page.request.post(origin + path, { data, headers: { origin: from } });
		const other = await browser.newContext();
		try {
			for (const path of ["/video/review", "/video/queue"]) {
				expect(
					(
						await other.request.post(origin + path, { data: h3Input, headers: { origin } })
					).status(),
				).toBe(401);
				expect((await post(path, h3Input, "http://localhost:4444")).status()).toBe(403);
			}
		} finally {
			await other.close();
		}

		await page.setViewportSize({ width: 320, height: 800 });
		await page.goto(`${origin}/video`);
		const picker = page.getByLabel("Video model and provider");
		await expect(picker.locator("option", { hasText: "H3 Max · ToAPIs" })).toBeDisabled();
		await expect(picker.locator("option", { hasText: "H3 Max · ToAPIs" })).toContainText(
			"Not available on ToAPIs in this release",
		);
		const promptField = page.getByRole("textbox", { name: "Prompt" });
		await promptField.fill(prompt);
		await page.getByLabel("Duration (seconds)").selectOption("4");
		await page.getByRole("button", { name: "Review request" }).press("Enter");
		await expect(page.getByText("Connect a readable ToAPIs model key in Settings.")).toBeVisible();
		await page.getByRole("checkbox", { name: /I accept/ }).check();
		await picker.selectOption("h3-max");
		await expect(page.getByRole("heading", { name: "H3 Max · Poyo.ai" })).toBeVisible();
		await expect(promptField).toHaveValue(prompt);
		await expect(page.getByLabel("Duration (seconds)")).toHaveValue("5");
		await expect(page.getByRole("combobox", { name: "Resolution" })).toHaveValue("768p");
		await expect(page.getByText("Generate audio")).toHaveCount(0);
		await expect(page.getByRole("checkbox", { name: /I accept/ })).toHaveCount(0);
		await expect(page.getByRole("button", { name: "Queue 1 request" })).toHaveCount(0);

		// Keyboard selection of the framing guide.
		await promptField.press("Tab");
		await expect(page.getByRole("radio", { name: "16:9", exact: true })).toBeFocused();
		await page.keyboard.press("ArrowLeft");
		await page.keyboard.press("ArrowRight");
		await expect(page.getByRole("radio", { name: "16:9", exact: true })).toBeChecked();
		await expect(page.getByText("Framing · 16:9")).toBeVisible();

		const first = page.waitForResponse((r) => new URL(r.url()).pathname === "/video/review");
		await page.getByRole("button", { name: "Review request" }).press("Enter");
		const reviewed = await (await first).json();
		expect(reviewed.preview).toEqual({
			model: "h3-max",
			input: { ...h3Draft, enable_safety_checker: false },
		});
		await expect(page.getByText(/Estimated 80 Poyo\.ai credits/)).toBeVisible();
		await expect(page.getByRole("link", { name: /Public catalog, 2026-/ })).toBeVisible();
		await expect(page.getByText("1 potentially billable submission")).toBeVisible();
		await expect(page.getByText(/MP4 files up to 15 seconds, the provider's/)).toBeVisible();
		expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
			true,
		);
		const queue = page.getByRole("button", { name: "Queue 1 request" });
		const acceptance = page.getByRole("checkbox", {
			name: "I accept the estimate and Gallery Save limitations.",
		});
		await expect(queue).toBeDisabled();
		// A known quote with the Save disclosure unaccepted sends nothing.
		expect(
			(
				await post("/video/queue", { ...h3Input, token: reviewed.token, acceptTerms: false })
			).status(),
		).toBe(400);
		expect(counts.posts).toBe(0);
		expect(reviewed.blockers).toEqual([]);
		await acceptance.press("Space");
		await expect(queue).toBeEnabled();
		const again = page.waitForResponse((r) => new URL(r.url()).pathname === "/video/review");
		await page.getByRole("button", { name: "Review request" }).press("Enter");
		const { token } = await (await again).json();
		await expect(acceptance).not.toBeChecked();
		await expect(queue).toBeDisabled();
		await acceptance.press("Space");

		// An interrupted Queue response keeps the reviewed token. Retrying it sends nothing new.
		const clicks: string[] = [];
		await page.route("**/video/queue", async (route) => {
			clicks.push(route.request().postDataJSON().token);
			if (clicks.length === 1) {
				expect((await route.fetch()).status()).toBe(200);
				await route.abort("failed");
			} else await route.continue();
		});
		await queue.press("Enter");
		await expect(page.getByText(/Queue response was interrupted/)).toBeVisible();
		await expect(acceptance).toBeChecked();
		await queue.press("Enter");
		await expect(page).toHaveURL(/\/jobs#job-/);
		expect(clicks).toEqual([token, token]);
		expect(counts.posts).toBe(1);

		const article = page.getByRole("article");
		await expect(article.getByText("Completed", { exact: true })).toBeVisible({ timeout: 25_000 });
		await expect(article.getByText(/78 Poyo\.ai credits/)).toBeVisible();
		// Automatic publication replaces the Save click.
		await expect(article.getByRole("button", { name: "Save to Gallery" })).toHaveCount(0);
		const open = article.getByRole("link", { name: "Open saved video" });
		await expect(open).toBeVisible({ timeout: 20_000 });
		await expect(article.locator("[data-library]")).toHaveText("Saved");
		await open.press("Enter");
		await expect(page).toHaveURL(/\/gallery\/[0-9a-f-]+$/);
		const path = new URL(page.url()).pathname;
		await server.stop();
		server = await startStudio(directory, port, false, env);
		await page.request.post(`${origin}/settings/providers?/remove`, {
			headers: { origin, accept: "text/html" },
			form: { provider: "poyo" },
		});
		const requests = fixture.requests.length;
		await page.goto(origin + path);
		const video = page.getByLabel("Saved video playback");
		await expect(video).toBeVisible();
		await seekThenPlay(page, video);
		expect(await (await page.request.get(`${origin + path}/media?download=1`)).body()).toEqual(
			bytes,
		);
		await page.getByRole("link", { name: "Remove from Gallery" }).press("Enter");
		await page.getByRole("button", { name: "Remove from Gallery" }).press("Enter");
		await expect(page).toHaveURL(`${origin}/gallery`);
		expect(fixture.requests).toHaveLength(requests);
		expect(fixture.requests.some((r) => r.path.startsWith("/toapis"))).toBe(false);
		expect(counts.posts).toBe(1);
		expect(server.diagnostics()).not.toContain(new URL(h3ResultUrl).search);
	} finally {
		await server?.stop();
		fixture.stop();
		await rm(directory, { recursive: true, force: true });
		await rm(cache, { recursive: true, force: true });
	}
});

test("a dropped Queue response stays retryable after the rates expire and replays the same token once", async ({
	page,
}) => {
	test.setTimeout(60_000);
	const directory = await createOwnerDirectory();
	const cache = await createOwnerDirectory();
	const counts = { posts: 0 };
	const fixture = poyoFixtures(new Uint8Array(0), counts);
	let server: Studio | undefined;
	try {
		const rates = await writeReviewPricing(cache, 0, undefined, { "h3-max": h3Rate });
		await page.clock.install({ time: new Date(rates.observedMs + 60_000) });
		server = await startStudio(directory, "0", false, { ...fixture.env, XDG_CACHE_HOME: cache });
		const { origin } = server.origin;
		await signInWithPoyo(page, server);
		await page.goto(`${origin}/video?model=h3-max`);
		await page.getByRole("textbox", { name: "Prompt" }).fill(prompt);
		const reviewed = page.waitForResponse((r) => new URL(r.url()).pathname === "/video/review");
		await page.getByRole("button", { name: "Review request" }).press("Enter");
		const { token, quote } = await (await reviewed).json();
		await page.getByRole("checkbox", { name: /I accept/ }).check();
		const clicks: string[] = [];
		await page.route("**/video/queue", async (route) => {
			clicks.push(route.request().postData() ?? "");
			if (clicks.length === 1) {
				expect((await route.fetch()).status()).toBe(200);
				await route.abort("failed");
			} else await route.continue();
		});
		await page.getByRole("button", { name: "Queue 1 request" }).press("Enter");
		await expect(page.getByText(/Queue response was interrupted/)).toBeVisible();
		await page.clock.fastForward(Date.parse(quote.expiresAt) - rates.observedMs);
		// The pending retry, not a fresh Review, is the safe next step.
		await expect(page.getByRole("status")).toHaveText(
			"The reviewed rates expired. Retry the interrupted request or check Jobs before reviewing again.",
		);
		await expect(page.getByRole("button", { name: "Queue 1 request" })).toHaveCount(0);
		await page.getByRole("textbox", { name: "Prompt" }).fill("A later edit.");
		await page.getByRole("button", { name: "Retry the interrupted request" }).press("Enter");
		await expect(page).toHaveURL(/\/jobs#job-/);
		expect(clicks).toHaveLength(2);
		expect(clicks[1]).toBe(clicks[0]);
		expect(JSON.parse(clicks[0])).toMatchObject({ token, draft: { prompt } });
		expect(counts.posts).toBe(1);
		await expect(page.getByRole("article")).toHaveCount(1);
	} finally {
		await server?.stop();
		fixture.stop();
		await rm(directory, { recursive: true, force: true });
		await rm(cache, { recursive: true, force: true });
	}
});

test("a refused retry of a request that never arrived keeps the newer Review", async ({ page }) => {
	test.setTimeout(60_000);
	const directory = await createOwnerDirectory();
	const cache = await createOwnerDirectory();
	const counts = { posts: 0 };
	const fixture = poyoFixtures(new Uint8Array(0), counts);
	let server: Studio | undefined;
	try {
		await writeReviewPricing(cache, 0, undefined, { "h3-max": h3Rate });
		server = await startStudio(directory, "0", false, { ...fixture.env, XDG_CACHE_HOME: cache });
		const { origin } = server.origin;
		await signInWithPoyo(page, server);
		await page.goto(`${origin}/video?model=h3-max`);
		const promptField = page.getByRole("textbox", { name: "Prompt" });
		await promptField.fill(prompt);
		await page.getByRole("button", { name: "Review request" }).press("Enter");
		await page.getByRole("checkbox", { name: /I accept/ }).check();
		let dropped = false;
		await page.route("**/video/queue", async (route) => {
			if (dropped) return route.continue();
			dropped = true;
			// The request never reaches the server, so its token is never claimed.
			await route.abort("failed");
		});
		await page.getByRole("button", { name: "Queue 1 request" }).press("Enter");
		await expect(page.getByText(/Queue response was interrupted/)).toBeVisible();
		// The H3 rate disappears, so the unclaimed token is stale and a new Review is unpriced.
		await writeReviewPricing(cache, 0);
		await promptField.fill("A newer request.");
		await page.getByRole("button", { name: "Review request" }).press("Enter");
		await expect(page.getByText("Request reviewed.")).toBeVisible();
		const consent = page.getByRole("checkbox", { name: /I accept/ });
		await consent.check();
		await page.getByRole("button", { name: "Retry the interrupted request" }).press("Enter");
		await expect(page.getByRole("status")).toHaveText(
			"The interrupted request was never queued. Nothing was sent.",
		);
		await expect(page.getByRole("button", { name: "Retry the interrupted request" })).toHaveCount(
			0,
		);
		await expect(page.getByRole("button", { name: "Queue 1 request" })).toBeEnabled();
		await expect(consent).toBeChecked();
		expect(counts.posts).toBe(0);
	} finally {
		await server?.stop();
		fixture.stop();
		await rm(directory, { recursive: true, force: true });
		await rm(cache, { recursive: true, force: true });
	}
});

test("a refused retry of the displayed Review clears it, and an unauthenticated retry stays pending", async ({
	page,
}) => {
	test.setTimeout(60_000);
	const directory = await createOwnerDirectory();
	const cache = await createOwnerDirectory();
	const counts = { posts: 0 };
	const fixture = poyoFixtures(new Uint8Array(0), counts);
	let server: Studio | undefined;
	try {
		await writeReviewPricing(cache, 0, undefined, { "h3-max": h3Rate });
		server = await startStudio(directory, "0", false, { ...fixture.env, XDG_CACHE_HOME: cache });
		const { origin } = server.origin;
		await signInWithPoyo(page, server);
		await page.goto(`${origin}/video?model=h3-max`);
		await page.getByRole("textbox", { name: "Prompt" }).fill(prompt);
		await page.getByRole("button", { name: "Review request" }).press("Enter");
		await page.getByRole("checkbox", { name: /I accept/ }).check();
		let dropped = false;
		await page.route("**/video/queue", async (route) => {
			if (dropped) return route.continue();
			dropped = true;
			await route.abort("failed");
		});
		await page.getByRole("button", { name: "Queue 1 request" }).press("Enter");
		await expect(page.getByText(/Queue response was interrupted/)).toBeVisible();
		const retry = page.getByRole("button", { name: "Retry the interrupted request" });
		// Without a session the server cannot say whether the token was claimed.
		const cookies = await page.context().cookies();
		await page.context().clearCookies();
		await retry.press("Enter");
		await expect(page.getByRole("status")).toHaveText(
			"The retry could not be confirmed. Sign in again if needed, then check Jobs before queuing.",
		);
		await expect(retry).toBeVisible();
		await page.context().addCookies(cookies);
		// The withdrawn rate makes the unclaimed token stale; it is the displayed Review's token.
		await writeReviewPricing(cache, 0);
		await retry.press("Enter");
		await expect(page.getByRole("status")).toHaveText(
			"The interrupted request was never queued. Nothing was sent. Review the request again before queuing.",
		);
		await expect(retry).toHaveCount(0);
		await expect(page.getByRole("button", { name: "Queue 1 request" })).toHaveCount(0);
		expect(counts.posts).toBe(0);
	} finally {
		await server?.stop();
		fixture.stop();
		await rm(directory, { recursive: true, force: true });
		await rm(cache, { recursive: true, force: true });
	}
});

test("an unknown H3 price needs consent naming it, and a Security change clears the H3 draft", async ({
	page,
	context,
}) => {
	test.setTimeout(60_000);
	const { TOTP } = await import("otpauth");
	const directory = await createOwnerDirectory();
	const cache = await createOwnerDirectory();
	const counts = { posts: 0 };
	const fixture = poyoFixtures(new Uint8Array(0), counts);
	let server: Studio | undefined;
	try {
		// The bundle prices h3-max, so a fresher cached v2 feed without it keeps the price unknown.
		await writeReviewPricing(cache, 0);
		server = await startStudio(directory, "0", false, { ...fixture.env, XDG_CACHE_HOME: cache });
		const { origin } = server.origin;
		const password = await signInWithPoyo(page, server);
		await page.goto(`${origin}/video?model=h3-max`);
		await expect(page.getByRole("heading", { name: "H3 Max · Poyo.ai" })).toBeVisible();
		const promptField = page.getByRole("textbox", { name: "Prompt" });
		await promptField.fill(prompt);
		await page.getByRole("button", { name: "Review request" }).press("Enter");
		await expect(page.getByText(/Total unknown\. No local rate/)).toBeVisible();
		const consent = page.getByRole("checkbox", {
			name: "I accept the unknown price and Gallery Save limitations.",
		});
		await consent.check();
		expect(counts.posts).toBe(0);

		const security = await context.newPage();
		try {
			await security.goto(`${origin}/settings/security`);
			await security.getByLabel("Current password").fill(password);
			await security.getByRole("button", { name: "Set up authenticator" }).click();
			const seed = await security.locator("section code").first().textContent();
			if (!seed) throw new Error("Missing manual setup.");
			await security
				.getByLabel("New authenticator code")
				.fill(new TOTP({ secret: seed }).generate());
			await security.getByRole("button", { name: "Confirm authenticator" }).click();
			await expect(security.locator("section li")).toHaveCount(10);
		} finally {
			await security.close();
		}
		await expect(promptField).toHaveValue("");
		await expect(consent).toHaveCount(0);
		await expect(page).toHaveURL(`${origin}/video?model=h3-max`);
		await expect(page.getByRole("heading", { name: "H3 Max · Poyo.ai" })).toBeVisible();
		expect(counts.posts).toBe(0);
	} finally {
		await server?.stop();
		fixture.stop();
		await rm(directory, { recursive: true, force: true });
		await rm(cache, { recursive: true, force: true });
	}
});
