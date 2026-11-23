import { readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { createSeedreamDraft } from "../../src/lib/shared/image-studio/seedream";
import { jobResponses } from "../fixtures/job-responses";
import { createOwnerDirectory } from "../fixtures/owner-directory";
import { providerFixtureKeys, startProviderFixtures } from "../fixtures/provider-connections";
import { referencePng } from "../fixtures/reference-image";
import { startStudio } from "./built-studio";

type Studio = Awaited<ReturnType<typeof startStudio>>;

async function claimWithPoyo(page: Page, server: Studio) {
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
			page.request.post(origin + path, { data, headers: { origin } });
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

		// Every available tile and the viewer offer an ordinary download with the short job id.
		await page.goto(`${origin}/gallery`);
		const tileDownload = page.getByRole("link", { name: `Download image ${short}` });
		await expect(tileDownload).toHaveAttribute("download", "");
		expect(await download(page, tileDownload)).toEqual({ name, bytes: referencePng });
		const attachment = await page.request.get(`${origin}/gallery/${jobId}/media?download=1`);
		expect(attachment.headers()["content-disposition"]).toBe(`attachment; filename="${name}"`);
		await page.getByRole("link", { name: new RegExp(`Image ${short}`) }).press("Enter");
		const viewerDownload = page.getByRole("link", { name: "Download image" });
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
			).toBe(303);
		} finally {
			await other.close();
		}
		expect(
			(
				await page.request.post(`${origin}/jobs?/download`, {
					headers: { origin: "http://127.0.0.1:9" },
					form: { id: jobId },
				})
			).status(),
		).toBe(403);
		expect(
			(
				await page.request.get(`${origin}/gallery/${jobId}/media?download=1`, {
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
