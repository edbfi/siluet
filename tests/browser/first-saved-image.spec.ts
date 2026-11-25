import { readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Page } from "@playwright/test";
import { createSeedreamDraft } from "../../src/lib/shared/image-studio/seedream";
import { jobResponses } from "../fixtures/job-responses";
import { createOwnerDirectory } from "../fixtures/owner-directory";
import {
	providerFixtureAccount,
	providerFixtureKeys,
	startProviderFixtures,
} from "../fixtures/provider-connections";
import { referenceGif, referencePng } from "../fixtures/reference-image";
import { writeReviewPricing } from "../fixtures/review-pricing";
import { startStudio } from "./built-studio";
import { test } from "./studio-test";

const prompt = "A folded paper fan beside a blue vase, private fixture.";
type Studio = Awaited<ReturnType<typeof startStudio>>;
async function connect(page: Page, server: Studio, provider: "toapis" | "poyo") {
	const origin = server.origin.origin;
	await expect.poll(server.token).not.toBe("");
	const setup = await page.request.post(`${origin}/setup`, {
		headers: { origin, accept: "text/html" },
		form: { token: server.token(), username: "creator", password: crypto.randomUUID() },
		maxRedirects: 0,
	});
	expect(setup.status()).toBe(303);
	const saved = await page.request.post(`${origin}/settings/providers?/connect`, {
		headers: { origin, accept: "text/html" },
		form: { provider, key: providerFixtureKeys[provider] },
	});
	expect(saved.ok()).toBe(true);
}

for (const path of ["poyo", "toapis", "z-image generate", "z-image edit"] as const) {
	const provider = path === "toapis" ? "toapis" : "poyo";
	const zImage = path.startsWith("z-image");
	const edit = path === "z-image edit";
	const reference = "HTTPS://Media.Example.org:443/mural%2fsky?sig=fixture-secret%2fX#frame";
	test(`${path} queues once, saves and reopens the original bytes offline after restart`, async ({
		page,
		browser,
	}) => {
		test.setTimeout(edit ? 120_000 : 75_000);
		page.setDefaultTimeout(12_000);
		const dir = await createOwnerDirectory();
		const cacheHome = await createOwnerDirectory();
		const observedBodies: unknown[] = [];
		const respond = jobResponses();
		let firstStatus = true;
		const fixtures = startProviderFixtures(async (request, path) => {
			if (path === "/poyo/submit") observedBodies.push(await request.clone().json());
			// The edit's completing read carries no usable link, so Jobs offers Retry download.
			if (edit && path === "/poyo/status/poyo-fixture-1" && firstStatus) {
				firstStatus = false;
				return Response.json({
					code: 200,
					data: { task_id: "poyo-fixture-1", status: "finished", files: [] },
				});
			}
			return respond(request, path);
		});
		let server: Studio | undefined;
		try {
			server = await startStudio(dir, "0", false, { ...fixtures.env, XDG_CACHE_HOME: cacheHome });
			const origin = server.origin.origin;
			const outbound: string[] = [];
			await page.route(/^https?:/, (route) => {
				if (new URL(route.request().url()).origin === origin) return route.continue();
				outbound.push(new URL(route.request().url()).hostname);
				return route.abort();
			});
			await connect(page, server, provider);
			if (zImage) await writeReviewPricing(cacheHome, 0, edit ? undefined : "2");
			await page.setViewportSize({ width: 320, height: 760 });
			await page.goto(`${origin}/image`);
			await page.getByRole("textbox", { name: "Prompt", exact: true }).fill(prompt);
			if (provider === "toapis") {
				const picker = page.getByLabel("Model", { exact: true });
				await picker.selectOption("z-image");
				const settings = page.getByRole("link", { name: "Connect Poyo.ai in Settings" });
				await expect(settings).toHaveAttribute("href", "/settings/providers");
				await page.emulateMedia({ colorScheme: "dark" });
				await expect(settings).toHaveCSS("color", "rgb(169, 189, 255)");
				await expect(settings).toHaveCSS("min-height", "44px");
				await picker.focus();
				await picker.press("Tab");
				await expect(settings).toBeFocused();
				await expect(settings).toHaveCSS("outline-style", "solid");
				await page.emulateMedia({ colorScheme: null });
				await expect(page.getByRole("button", { name: "Queue 1 request" })).toBeDisabled();
				await picker.selectOption("seedream-5.5");
				await expect(page.getByLabel("Prompt", { exact: true })).toHaveValue(prompt);
			}
			if (zImage) {
				const picker = page.getByLabel("Model", { exact: true });
				// A native select's End key differs by platform (macOS opens a menu), so pick directly.
				await picker.selectOption("z-image");
				await expect(picker).toHaveValue("z-image");
				await expect(page.getByLabel("Prompt", { exact: true })).toHaveValue(prompt);
				if (edit) {
					await page.getByLabel("Operation", { exact: true }).selectOption("edit");
					await expect(page.locator("input[type=file]")).toHaveCount(0);
					const ratio = page.getByLabel("Aspect ratio", { exact: true });
					await expect(ratio).toHaveValue("");
					await ratio.selectOption("4:3");
					const source = page.getByLabel("Public image URL");
					await source.fill("http://localhost/private");
					await page.getByRole("button", { name: "Use URL", exact: true }).press("Enter");
					await expect(source).toHaveAttribute("aria-invalid", "true");
					await source.fill(reference);
					await page.getByRole("button", { name: "Use URL", exact: true }).press("Enter");
					await picker.selectOption("seedream-5.5");
					await picker.selectOption("z-image");
					await expect(source).toHaveValue("");
					await expect(ratio).toHaveValue("");
					await expect(page.getByLabel("Prompt", { exact: true })).toHaveValue(prompt);
					await source.fill(reference);
					await page.getByRole("button", { name: "Use URL", exact: true }).press("Enter");
					await page.getByLabel("Private name").fill("private fixture note");
				}
				await page.getByRole("tab", { name: "Outgoing request" }).press("Enter");
				const body = page.getByRole("region", { name: "JSON request body" });
				expect(JSON.parse((await body.textContent()) ?? "")).toEqual({
					model: "z-image",
					input: {
						prompt,
						...(edit ? { image_urls: ["[remote URL hidden]"] } : { size: "1:1" }),
						enable_safety_checker: false,
					},
				});
				expect(fixtures.requests.map((row) => row.path)).toEqual(["/poyo/balance"]);
				await page.getByRole("tab", { name: "Review", exact: true }).press("Enter");
			}
			if (zImage) {
				const invalid = {
					count: 1,
					retryLimit: 0,
					acceptUnknown: false,
					operationKey: {
						provider: "poyo",
						model: "z-image",
						route: "POST /api/generate/submit",
						operation: "reference-image-edit",
					},
					draft: {
						provider: "poyo",
						operation: "edit",
						prompt,
						options: {},
						references: [{ kind: "file", file: { name: "mock.png" } }],
					},
				};
				for (const route of ["/image/review", "/image/queue"])
					expect(
						(
							await page.request.post(origin + route, { headers: { origin }, data: invalid })
						).status(),
					).toBe(400);
			}
			const inspect = page.getByRole("button", { name: /^(Review request|Reviewing…)$/ });
			await inspect.press("Enter");
			await expect(inspect).toHaveCount(0);
			if (zImage) {
				await expect(page.getByText(/Whether Z-Image accepts or honors it/)).toBeVisible();
				expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
					320,
				);
			}
			const checkbox = page.getByRole("checkbox", { name: /unknown/i });
			if (zImage) {
				await expect(checkbox).toHaveCount(edit ? 1 : 0);
				if (edit)
					await expect(page.getByRole("button", { name: "Queue 1 request" })).toBeDisabled();
				else await expect(page.getByText("Estimated 2 Poyo.ai credits per request")).toBeVisible();
			}
			if (provider === "toapis" || (await checkbox.count())) await checkbox.check();
			const queue = page.getByRole("button", { name: "Queue 1 request" });
			await expect(queue).toBeEnabled();
			const click = page.waitForRequest(
				(req) => req.url() === origin + "/image/queue" && req.method() === "POST",
			);
			await queue.press("Enter");
			const submitted = (await click).postDataJSON();
			await expect(page).toHaveURL(/\/jobs/);
			const article = page.getByRole("article");
			await expect(article.getByText("Completed", { exact: true })).toBeVisible({
				timeout: 20_000,
			});
			expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
				320,
			);
			if (zImage) {
				await expect(article.getByRole("heading", { name: "Z-Image · Poyo.ai" })).toBeVisible();
				await page.reload();
				expect(observedBodies).toEqual([
					{
						model: "z-image",
						input: {
							prompt,
							...(edit ? { image_urls: [reference] } : { size: "1:1" }),
							enable_safety_checker: false,
						},
					},
				]);
			}
			// Siluet saves without a click; there is no Save button.
			const library = article.locator("[data-library]");
			await expect(article.getByRole("button", { name: "Save to Gallery" })).toHaveCount(0);
			if (edit) {
				await expect(library).toHaveText("Download failed", { timeout: 20_000 });
				const port = server.origin.port;
				await server.stop();
				server = undefined;
				server = await startStudio(dir, port, false, fixtures.env);
				await page.reload();
				await expect(library).toHaveText("Download failed");
				const retry = article.getByRole("button", { name: "Retry download" });
				await retry.focus();
				await retry.press("Enter");
				await expect(retry).toHaveCount(0);
				await expect(library).toBeFocused();
			}
			const open = article.getByRole("link", { name: "Open saved image" });
			await expect(open).toBeVisible({ timeout: 20_000 });
			await expect(library).toHaveText("Saved");
			const path = await open.getAttribute("href");
			if (!path) throw new Error("Missing Gallery link.");
			const media = `${origin}${path}/media`;
			const generation = fixtures.requests.filter((row) => row.path.endsWith("/submit"));
			expect(generation).toEqual([
				{ method: "POST", path: `/${provider}/submit`, key: providerFixtureKeys[provider] },
			]);
			expect(fixtures.requests.filter((row) => row.path === "/media/image")).toEqual([
				{ path: "/media/image", method: "GET", key: null },
			]);
			const sentinels = [
				prompt,
				providerFixtureKeys[provider],
				providerFixtureAccount,
				reference,
				"private fixture note",
				"fixture-private-signed-token",
			];
			const safeLogs = (text: string) => {
				for (const value of sentinels) expect(text).not.toContain(value);
			};
			safeLogs(server.diagnostics());
			safeLogs(await page.evaluate(() => JSON.stringify([localStorage, sessionStorage])));
			const port = server.origin.port;
			await server.stop();
			server = undefined;
			for (const name of await readdir(dir)) {
				if (name.startsWith("studio.db"))
					safeLogs((await readFile(join(dir, name))).toString("latin1"));
			}
			server = await startStudio(dir, port, false, fixtures.env);
			if (zImage) {
				const replay = await page.request.post(origin + "/image/queue", {
					headers: { origin },
					data: submitted,
				});
				expect(replay.ok()).toBe(true);
				expect(await replay.json()).toEqual({ jobId: path.split("/").pop() });
				expect(observedBodies).toHaveLength(1);
			}
			const before = fixtures.requests.length;
			const removed = await page.request.post(`${origin}/settings/providers?/remove`, {
				headers: { origin, accept: "text/html" },
				form: { provider, jobWarning: "seen" },
			});
			expect(removed.ok()).toBe(true);
			await page.goto(origin + path);
			const image = await page.request.get(media);
			expect(image.status()).toBe(200);
			expect(image.headers()["content-type"]).toBe("image/png");
			expect(image.headers()["cache-control"]).toBe("private, no-store");
			expect(image.headers()["x-content-type-options"]).toBe("nosniff");
			expect(await image.body()).toEqual(referencePng);
			const other = await browser.newContext();
			try {
				const privateImage = await other.request.get(media, { maxRedirects: 0 });
				expect(privateImage.status()).toBe(303);
				for (const route of [
					"/image/queue",
					"/image/review",
					"/jobs?/download",
					`${path}/remove`,
				]) {
					expect(
						(await other.request.post(origin + route, { headers: { origin }, data: {} })).status(),
					).toBe(401);
				}
			} finally {
				await other.close();
			}
			await page.goto(`${origin}${path}/remove`);
			await page.getByRole("button", { name: /remove/i }).press("Enter");
			await expect(page).toHaveURL(`${origin}/gallery`);
			await server.stop();
			server = undefined;
			server = await startStudio(dir, port, false, fixtures.env);
			expect((await page.request.get(media)).status()).toBe(404);
			expect(fixtures.requests.length).toBe(before);
			safeLogs(server.diagnostics());
			expect(outbound).toEqual([]);
		} finally {
			await server?.stop();
			fixtures.stop();
			await rm(cacheHome, { recursive: true, force: true });
			await rm(dir, { recursive: true, force: true });
		}
	});
}

test("a complete image outside the profile stays not saved across restart and Refresh", async ({
	page,
}) => {
	test.setTimeout(60_000);
	page.setDefaultTimeout(12_000);
	const dir = await createOwnerDirectory();
	const respond = jobResponses();
	const fixtures = startProviderFixtures((request, path) =>
		path === "/media/image"
			? new Response(referenceGif, { headers: { "content-type": "image/gif" } })
			: respond(request, path),
	);
	let server: Studio | undefined;
	try {
		server = await startStudio(dir, "0", false, fixtures.env);
		await connect(page, server, "poyo");
		const origin = server.origin.origin;
		const input = {
			draft: { ...createSeedreamDraft("poyo"), prompt },
			count: 1,
			retryLimit: 0,
			acceptUnknown: false,
		};
		const post = (path: string, data: unknown) =>
			page.request.post(origin + path, { data, headers: { origin } });
		const review = await (await post("/image/review", input)).json();
		const queued = await post("/image/queue", {
			...input,
			token: review.token,
			acceptUnknown: review.requiresConsent,
		});
		expect(queued.status()).toBe(200);
		await page.goto(`${origin}/jobs`);
		const article = page.getByRole("article");
		const library = article.locator("[data-library]");
		const text = "Not saved · this image is outside the Gallery profile";
		await expect(library).toHaveText(text, { timeout: 20_000 });
		await expect(article.getByRole("button", { name: /download/i })).toHaveCount(0);
		const port = server.origin.port;
		await server.stop();
		server = undefined;
		server = await startStudio(dir, port, false, fixtures.env);
		await page.reload();
		await expect(library).toHaveText(text);
		const refresh = article.getByRole("button", { name: "Refresh status" });
		await expect(refresh).toBeEnabled({ timeout: 20_000 });
		await refresh.press("Enter");
		await expect(refresh).toBeEnabled({ timeout: 20_000 });
		await expect(library).toHaveText(text);
		expect(fixtures.requests.filter((row) => row.path === "/media/image")).toHaveLength(1);
		expect(fixtures.requests.filter((row) => row.path.endsWith("/submit"))).toHaveLength(1);
	} finally {
		await server?.stop();
		fixtures.stop();
		await rm(dir, { recursive: true, force: true });
	}
});

for (const point of ["before-dispatch", "after-acceptance"] as const) {
	test(`a process stop ${point} preserves the claim and replay never dispatches again`, async ({
		page,
	}) => {
		const dir = await createOwnerDirectory();
		const fixture = startProviderFixtures(jobResponses(point));
		let server: Studio | undefined;
		try {
			server = await startStudio(dir, "0", false, fixture.env);
			await connect(page, server, "poyo");
			const origin = server.origin.origin;
			const port = server.origin.port;
			const input = {
				draft: { ...createSeedreamDraft("poyo"), prompt },
				count: 1,
				retryLimit: 0,
				acceptUnknown: false,
			};
			const post = (path: string, data: unknown, from = origin) =>
				page.request.post(origin + path, { data, headers: { origin: from } });
			expect((await post("/image/review", input, "https://other.test")).status()).toBe(403);
			const review = await (await post("/image/review", input)).json();
			const click = { ...input, token: review.token, acceptUnknown: review.requiresConsent };
			expect((await post("/image/queue", click, "https://other.test")).status()).toBe(403);
			expect((await post("/image/queue", { ...click, count: 2 })).status()).toBe(400);
			expect(
				(
					await post("/image/queue", { ...click, draft: { ...input.draft, operation: "edit" } })
				).status(),
			).toBe(400);
			let interrupted = false;
			try {
				await post("/image/queue", click);
			} catch {
				interrupted = true;
			}
			expect(interrupted).toBe(true);
			await server.stop(false);
			server = undefined;
			server = await startStudio(dir, port, false, fixture.env);
			const count = fixture.requests.length;
			const replay = await post("/image/queue", click);
			expect(replay.status()).toBe(200);
			expect(await replay.json()).toHaveProperty("jobId");
			await page.goto(`${origin}/jobs`);
			await expect(page.getByText("May have been submitted", { exact: true })).toBeVisible();
			expect(fixture.requests.length).toBe(count);
			expect(fixture.requests.filter((r) => r.path === "/poyo/submit").length).toBe(
				point === "before-dispatch" ? 0 : 1,
			);
		} finally {
			await server?.stop(false);
			fixture.stop();
			await rm(dir, { recursive: true, force: true });
		}
	});
}

test("429 shows the deadline and the next Queue reuses the same token", async ({ page }) => {
	test.setTimeout(60_000);
	page.setDefaultTimeout(12_000);
	const dir = await createOwnerDirectory();
	const cacheHome = await createOwnerDirectory();
	const fixtures = startProviderFixtures(jobResponses());
	let server: Studio | undefined;
	try {
		server = await startStudio(dir, "0", false, { ...fixtures.env, XDG_CACHE_HOME: cacheHome });
		const origin = server.origin.origin;
		await connect(page, server, "poyo");
		// Z-Image has no rate, so Review asks for consent to an unknown cost.
		await writeReviewPricing(cacheHome);
		const reviews: unknown[] = [];
		const queued: { token: string; acceptUnknown: boolean }[] = [];
		const until = Date.parse("2030-01-02T03:04:05.250Z");
		page.on("request", (request) => {
			if (request.url() === `${origin}/image/review`) reviews.push(request.postDataJSON());
		});
		// The first Queue meets the provider cooldown. Later clicks reach the built server.
		await page.route(`${origin}/image/queue`, (route) => {
			queued.push(route.request().postDataJSON());
			return queued.length === 1
				? route.fulfill({ status: 429, json: { error: "cooldown", until } })
				: route.continue();
		});
		await page.goto(`${origin}/image`);
		await page.getByLabel("Model", { exact: true }).selectOption("z-image");
		await page.getByRole("textbox", { name: "Prompt", exact: true }).fill(prompt);
		const review = page.getByRole("region", { name: "Review request", exact: true });
		await review.getByRole("button", { name: "Review request", exact: true }).press("Enter");
		const consent = review.getByRole("checkbox", { name: /unknown cost/i });
		await consent.check();
		const queue = review.getByRole("button", { name: "Queue 1 request" });
		await queue.press("Enter");
		await expect(review.getByRole("status")).toHaveText(
			"The provider is cooling down. Nothing was sent. Click Queue again after 2030-01-02 03:04:06 UTC.",
		);
		await expect(consent).toBeChecked();
		await expect(queue).toBeEnabled();
		expect(fixtures.requests.filter((row) => row.path.endsWith("/submit"))).toEqual([]);

		await queue.press("Enter");
		await expect(page).toHaveURL(/\/jobs#job-/);
		expect(reviews).toHaveLength(1);
		expect(queued).toHaveLength(2);
		expect(queued[1].token).toBe(queued[0].token);
		expect(queued.map((body) => body.acceptUnknown)).toEqual([true, true]);
		expect(fixtures.requests.filter((row) => row.path.endsWith("/submit"))).toEqual([
			{ method: "POST", path: "/poyo/submit", key: providerFixtureKeys.poyo },
		]);
	} finally {
		await server?.stop();
		fixtures.stop();
		await rm(cacheHome, { recursive: true, force: true });
		await rm(dir, { recursive: true, force: true });
	}
});

test("a 429 that arrives after the reviewed rates expire keeps the expiry notice", async ({
	page,
}) => {
	test.setTimeout(60_000);
	page.setDefaultTimeout(12_000);
	const dir = await createOwnerDirectory();
	const cacheHome = await createOwnerDirectory();
	const fixtures = startProviderFixtures(jobResponses());
	let server: Studio | undefined;
	try {
		// A known Z-Image rate gives the Review an expiry the page watches.
		const rates = await writeReviewPricing(cacheHome, 0, "2");
		await page.clock.install({ time: new Date(rates.observedMs + 60_000) });
		server = await startStudio(dir, "0", false, { ...fixtures.env, XDG_CACHE_HOME: cacheHome });
		const origin = server.origin.origin;
		await connect(page, server, "poyo");
		const held = Promise.withResolvers<void>();
		const arrived = Promise.withResolvers<void>();
		await page.route(`${origin}/image/queue`, async (route) => {
			arrived.resolve();
			await held.promise;
			await route.fulfill({ status: 429, json: { error: "cooldown", until: Date.now() + 60_000 } });
		});
		await page.goto(`${origin}/image`);
		await page.getByLabel("Model", { exact: true }).selectOption("z-image");
		await page.getByRole("textbox", { name: "Prompt", exact: true }).fill(prompt);
		const review = page.getByRole("region", { name: "Review request", exact: true });
		await review.getByRole("button", { name: "Review request", exact: true }).press("Enter");
		const queue = review.getByRole("button", { name: "Queue 1 request" });
		await expect(queue).toBeEnabled();
		await queue.press("Enter");
		await arrived.promise;
		// The rates expire while the Queue request is still in flight.
		await page.clock.fastForward(31 * 24 * 60 * 60 * 1000);
		await expect(review.getByRole("status")).toHaveText(
			"The reviewed rates expired. Review the request again before queuing.",
		);
		const late = page.waitForResponse(`${origin}/image/queue`);
		held.resolve();
		await late;
		// The button returns from "Queuing…" only after the page has handled the late 429.
		await expect(queue).toBeDisabled();
		await expect(review.getByRole("status")).toHaveText(
			"The reviewed rates expired. Review the request again before queuing.",
		);
		expect(fixtures.requests.filter((row) => row.path.endsWith("/submit"))).toEqual([]);
	} finally {
		await server?.stop();
		fixtures.stop();
		await rm(cacheHome, { recursive: true, force: true });
		await rm(dir, { recursive: true, force: true });
	}
});
