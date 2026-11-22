import { readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { createSeedreamDraft } from "../../src/lib/shared/image-studio/seedream";
import { jobResponses } from "../fixtures/job-responses";
import { createOwnerDirectory } from "../fixtures/owner-directory";
import {
	providerFixtureAccount,
	providerFixtureKeys,
	startProviderFixtures,
} from "../fixtures/provider-connections";
import { referencePng } from "../fixtures/reference-image";
import { startStudio } from "./built-studio";

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

for (const provider of ["poyo", "toapis"] as const) {
	test(`${provider} queues once, saves and reopens the original bytes offline after restart`, async ({
		page,
		browser,
	}) => {
		test.setTimeout(75_000);
		const dir = await createOwnerDirectory();
		const fixtures = startProviderFixtures(jobResponses());
		let server: Studio | undefined;
		try {
			server = await startStudio(dir, "0", false, fixtures.env);
			const origin = server.origin.origin;
			await connect(page, server, provider);
			await page.setViewportSize({ width: 320, height: 760 });
			await page.goto(`${origin}/image`);
			await page.getByRole("textbox", { name: "Prompt", exact: true }).fill(prompt);
			const inspect = page.getByRole("button", { name: /^(Review request|Reviewing…)$/ });
			await inspect.press("Enter");
			await expect(inspect).toHaveCount(0);
			const checkbox = page.getByRole("checkbox", { name: /unknown/i });
			if (provider === "toapis" || (await checkbox.count())) await checkbox.check();
			const queue = page.getByRole("button", { name: "Queue 1 request" });
			await expect(queue).toBeEnabled();
			await queue.press("Enter");
			await expect(page).toHaveURL(/\/jobs/);
			const article = page.getByRole("article");
			await expect(article.getByText("Completed", { exact: true })).toBeVisible({
				timeout: 20_000,
			});
			expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
				320,
			);
			const save = article.getByRole("button", { name: "Save to Gallery" });
			await expect(save).toBeEnabled({ timeout: 20_000 });
			await save.press("Enter");
			const open = article.getByRole("link", { name: "Open saved image" });
			await expect(open).toBeVisible();
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
				for (const route of ["/image/queue", "/image/review", "/jobs?/save", `${path}/remove`]) {
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
		} finally {
			await server?.stop();
			fixtures.stop();
			await rm(dir, { recursive: true, force: true });
		}
	});
}

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
