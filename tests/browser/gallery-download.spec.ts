import { readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Page } from "@playwright/test";
import { createSeedreamDraft } from "../../src/lib/shared/image-studio/seedream";
import { jobResponses } from "../fixtures/job-responses";
import { createOwnerDirectory } from "../fixtures/owner-directory";
import { providerFixtureKeys, startProviderFixtures } from "../fixtures/provider-connections";
import { referencePng } from "../fixtures/reference-image";
import { startStudio } from "./built-studio";
import { claimOwner, ownerRequest } from "./owner-session";
import { test } from "./studio-test";

type Studio = Awaited<ReturnType<typeof startStudio>>;

async function claimWithPoyo(page: Page, server: Studio) {
	const origin = server.origin.origin;
	await expect.poll(server.token).not.toBe("");
	await claimOwner(page, server, crypto.randomUUID());
	const saved = await ownerRequest(page).post(`${origin}/settings/providers?/connect`, {
		headers: { origin, accept: "text/html" },
		form: { provider: "poyo", key: providerFixtureKeys.poyo },
	});
	expect(saved.ok()).toBe(true);
}

async function download(page: Page, link: ReturnType<Page["getByRole"]>) {
	const [file] = await Promise.all([page.waitForEvent("download"), link.press("Enter")]);
	const path = await file.path();
	return { name: file.suggestedFilename(), bytes: await readFile(path) };
}

test("Gallery tiles and the viewer download the original image, and Jobs downloads it again", async ({
	page,
	browser,
}) => {
	test.setTimeout(90_000);
	page.setDefaultTimeout(12_000);
	const dir = await createOwnerDirectory();
	const fixtures = startProviderFixtures(jobResponses());
	let server: Studio | undefined;
	try {
		server = await startStudio(dir, "0", false, fixtures.env);
		await claimWithPoyo(page, server);
		const origin = server.origin.origin;
		const input = {
			draft: { ...createSeedreamDraft("poyo"), prompt: "A lantern on a quiet pier." },
			count: 1,
			retryLimit: 0,
			acceptUnknown: false,
		};
		const post = (path: string, data: unknown) =>
			ownerRequest(page).post(origin + path, { data, headers: { origin } });
		const review = await (await post("/image/review", input)).json();
		const queued = await post("/image/queue", {
			...input,
			token: review.token,
			acceptUnknown: review.requiresConsent,
		});
		const { jobId } = (await queued.json()) as { jobId: string };
		const short = jobId.slice(0, 8);
		const name = `siluet-image-${short}.png`;
		const media = () => fixtures.requests.filter((row) => row.path === "/media/image").length;

		// Saved without a click.
		await page.goto(`${origin}/jobs`);
		const article = page.getByRole("article");
		const library = article.locator("[data-library]");
		await expect(library).toHaveText("Saved", { timeout: 20_000 });
		await expect(library).toHaveAttribute("aria-live", "polite");
		expect(media()).toBe(1);

		// Every available tile and the viewer download the authenticated copy under the short job id.
		// Held reads show the link pending; a second press joins the first download.
		const held: (() => void)[] = [];
		const mediaRoute = (url: URL) => url.pathname === `/gallery/${jobId}/media`;
		await page.route(mediaRoute, async (route) => {
			const response = await route.fetch();
			await new Promise<void>((release) => held.push(release));
			await route.fulfill({ response });
		});
		await page.goto(`${origin}/gallery`);
		const tileDownload = page.getByRole("link", { name: `Download image ${short}` });
		await expect(tileDownload).toHaveAttribute("download", name);
		const status = page.getByRole("listitem").getByRole("status");
		await expect(status).toBeEmpty();
		// The tile's own read is held, so the download cannot reuse its blob.
		await expect.poll(() => held.length).toBe(1);
		const saved = download(page, tileDownload);
		await expect(tileDownload).toHaveAttribute("aria-busy", "true");
		await expect(status).toHaveText("Preparing download…");
		await expect.poll(() => held.length).toBe(2);
		await tileDownload.press("Enter");
		await page.waitForTimeout(500);
		expect(held).toHaveLength(2);
		for (const release of held) release();
		expect(await saved).toEqual({ name, bytes: referencePng });
		await expect(tileDownload).not.toHaveAttribute("aria-busy");
		await expect(status).toBeEmpty();
		await page.unroute(mediaRoute);
		expect(held).toHaveLength(2);
		// A read that fails says so, and Retry starts afresh.
		await page.route(mediaRoute, (route) => route.abort());
		await page.goto(`${origin}/gallery`);
		await expect(page.getByText("File unavailable")).toBeVisible();
		await tileDownload.press("Enter");
		const failed = page.getByRole("alert");
		await expect(failed).toHaveText("The download could not start. Retry.");
		await expect(tileDownload).not.toHaveAttribute("aria-busy");
		await page.unroute(mediaRoute);
		expect(await download(page, tileDownload)).toEqual({ name, bytes: referencePng });
		await expect(failed).toHaveCount(0);
		const attachment = await ownerRequest(page).get(`${origin}/gallery/${jobId}/media?download=1`);
		expect(attachment.headers()["content-disposition"]).toBe(`attachment; filename="${name}"`);
		// The saved image is a sandboxed document that no page can frame.
		const inline = await ownerRequest(page).get(`${origin}/gallery/${jobId}/media`);
		expect(inline.headers()).toMatchObject({
			"content-type": "image/png",
			"cross-origin-resource-policy": "same-origin",
			"x-frame-options": "DENY",
			"x-content-type-options": "nosniff",
			"referrer-policy": "same-origin",
			"content-security-policy":
				"default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; sandbox",
		});
		// Opened on its own, a media link carries no bearer and gets nothing.
		const direct = await page.goto(`${origin}/gallery/${jobId}/media`);
		expect(direct?.status()).toBe(401);
		expect(direct?.headers()["cache-control"]).toBe("private, no-store");
		await page.goto(`${origin}/gallery`);
		await page.getByRole("link", { name: new RegExp(`Image ${short}`) }).press("Enter");
		// Exact, so it cannot match the outgoing tile's "Download image <id>" mid-navigation.
		const viewerDownload = page.getByRole("link", { name: "Download image", exact: true });
		expect(await download(page, viewerDownload)).toEqual({ name, bytes: referencePng });

		// Signed-out and foreign-origin requests cannot download or re-arm anything.
		const other = await browser.newContext();
		try {
			expect(
				(
					await other.request.post(`${origin}/jobs?/download`, {
						headers: { origin },
						form: { id: jobId },
					})
				).status(),
			).toBe(401);
			expect(
				(
					await other.request.get(`${origin}/gallery/${jobId}/media?download=1`, {
						maxRedirects: 0,
					})
				).status(),
			).toBe(401);
		} finally {
			await other.close();
		}
		expect(
			(
				await ownerRequest(page).post(`${origin}/jobs?/download`, {
					headers: { origin: "http://127.0.0.1:9" },
					form: { id: jobId },
				})
			).status(),
		).toBe(403);
		expect(
			(
				await ownerRequest(page).get(`${origin}/gallery/${jobId}/media?download=1`, {
					headers: { origin: "http://127.0.0.1:9" },
				})
			).status(),
		).toBe(403);

		// A missing file shows as unavailable with no tile download until Download again.
		const [file] = (await readdir(dir)).filter((entry) => entry.startsWith("gallery-"));
		await rm(join(dir, file));
		await page.goto(`${origin}/gallery`);
		await expect(page.getByText("File unavailable")).toBeVisible();
		await expect(page.getByRole("link", { name: /^Download/ })).toHaveCount(0);
		await page.goto(`${origin}/jobs`);
		await expect(library).toHaveText("File missing from Gallery");
		const again = article.getByRole("button", { name: "Download again" });
		await again.focus();
		await again.press("Enter");
		await expect(again).toHaveCount(0);
		await expect(library).toBeFocused();
		await expect(library).toHaveText("Saved", { timeout: 20_000 });
		expect(media()).toBe(2);

		// Remove holds the item across restart until Download again.
		await page.goto(`${origin}/gallery/${jobId}/remove`);
		await page.getByRole("button", { name: /remove/i }).press("Enter");
		await expect(page).toHaveURL(`${origin}/gallery`);
		const port = server.origin.port;
		await server.stop();
		server = undefined;
		server = await startStudio(dir, port, false, fixtures.env);
		const before = fixtures.requests.length;
		await page.goto(`${origin}/jobs`);
		await expect(library).toHaveText("Removed from Gallery");
		await page.waitForTimeout(1_000);
		expect(fixtures.requests.length).toBe(before);
		await article.getByRole("button", { name: "Download again" }).press("Enter");
		await expect(library).toHaveText("Saved", { timeout: 20_000 });
		expect(media()).toBe(3);
		await page.goto(`${origin}/gallery`);
		expect(
			await download(page, page.getByRole("link", { name: `Download image ${short}` })),
		).toEqual({ name, bytes: referencePng });
		expect(fixtures.requests.filter((row) => row.path.endsWith("/submit"))).toHaveLength(1);
	} finally {
		await server?.stop();
		fixtures.stop();
		await rm(dir, { recursive: true, force: true });
	}
});
