import { readFile, rm } from "node:fs/promises";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page } from "@playwright/test";
import { createSeedreamDraft } from "../../src/lib/shared/image-studio/seedream";
import { jobResponses } from "../fixtures/job-responses";
import { createOwnerDirectory } from "../fixtures/owner-directory";
import { providerFixtureKeys, startProviderFixtures } from "../fixtures/provider-connections";
import { webpFixtures } from "../fixtures/webp";
import { startStudio } from "./built-studio";
import { claimOwner, ownerRequest } from "./owner-session";
import { test } from "./studio-test";

type Studio = Awaited<ReturnType<typeof startStudio>>;
const { saves } = await webpFixtures();

async function download(page: Page, link: ReturnType<Page["getByRole"]>, browserName: string) {
	if (browserName === "firefox") {
		// Firefox's default for WebP saves the file to the download folder, then opens that copy
		// in a tab; Playwright reports no download event for it.
		await link.focus();
		const [tab] = await Promise.all([
			page.context().waitForEvent("page"),
			page.keyboard.press("Enter"),
		]);
		await tab.waitForURL(/^file:/);
		const path = fileURLToPath(tab.url());
		await tab.close();
		const saved = { name: basename(path), bytes: await readFile(path) };
		// A second save under the same name would otherwise get a numbered name.
		await rm(path);
		return saved;
	}
	const [file] = await Promise.all([page.waitForEvent("download"), link.press("Enter")]);
	return { name: file.suggestedFilename(), bytes: await readFile(await file.path()) };
}

for (const [label, webp] of [
	["lossy with ICC, EXIF and XMP", saves["ICC, EXIF then XMP"]],
	["lossless with alpha", saves.losslessAlpha],
] as const) {
	test(`a ${label} WebP result saves, reopens with the provider offline and downloads as .webp`, async ({
		page,
		browserName,
	}) => {
		test.setTimeout(75_000);
		page.setDefaultTimeout(12_000);
		const dir = await createOwnerDirectory();
		const respond = jobResponses();
		const fixtures = startProviderFixtures((request, path) =>
			path === "/media/image"
				? new Response(webp, { headers: { "content-type": "image/webp" } })
				: respond(request, path),
		);
		let providersUp = true;
		let server: Studio | undefined;
		try {
			server = await startStudio(dir, "0", false, fixtures.env);
			const origin = server.origin.origin;
			const outbound: string[] = [];
			await page.route(/^https?:/, (route) => {
				if (new URL(route.request().url()).origin === origin) return route.continue();
				outbound.push(new URL(route.request().url()).hostname);
				return route.abort();
			});
			await expect.poll(server.token).not.toBe("");
			await claimOwner(page, server, crypto.randomUUID());
			const connected = await ownerRequest(page).post(`${origin}/settings/providers?/connect`, {
				headers: { origin, accept: "text/html" },
				form: { provider: "poyo", key: providerFixtureKeys.poyo },
			});
			expect(connected.ok()).toBe(true);
			const input = {
				draft: { ...createSeedreamDraft("poyo"), prompt: "A paper kite over a harbour." },
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
			const name = `siluet-image-${short}.webp`;

			// Saved without a click, from one transfer.
			await page.goto(`${origin}/jobs`);
			const library = page.getByRole("article").locator("[data-library]");
			await expect(library).toHaveText("Saved", { timeout: 20_000 });
			expect(fixtures.requests.filter((row) => row.path === "/media/image")).toHaveLength(1);

			// Providers go away, and Siluet restarts with only its own data.
			fixtures.stop();
			providersUp = false;
			const port = server.origin.port;
			await server.stop();
			server = undefined;
			server = await startStudio(dir, port, false, fixtures.env);

			const media = `${origin}/gallery/${jobId}/media`;
			const inline = await ownerRequest(page).get(media);
			expect(inline.status()).toBe(200);
			expect(inline.headers()).toMatchObject({
				"content-type": "image/webp",
				"content-disposition": "inline",
				"x-content-type-options": "nosniff",
			});
			expect(await inline.body()).toEqual(webp);
			const attachment = await ownerRequest(page).get(`${media}?download=1`);
			expect(attachment.headers()["content-disposition"]).toBe(`attachment; filename="${name}"`);

			await page.goto(`${origin}/gallery`);
			const tileDownload = page.getByRole("link", { name: `Download image ${short}` });
			await expect(tileDownload).toHaveAttribute("download", name);
			expect(await download(page, tileDownload, browserName)).toEqual({ name, bytes: webp });

			// Firefox leaves the opened WebP's navigation pending on this page, so load the viewer.
			await page.goto(`${origin}/gallery/${jobId}`);
			const shown = page.getByRole("img", { name: `Saved image from job ${short}` });
			await expect
				.poll(() => shown.evaluate((image: HTMLImageElement) => image.naturalWidth))
				.toBe(3);
			await expect(page.getByText("WebP · 3 × 2")).toBeVisible();
			const viewerDownload = page.getByRole("link", { name: "Download image", exact: true });
			expect(await download(page, viewerDownload, browserName)).toEqual({ name, bytes: webp });

			expect(fixtures.requests.filter((row) => row.path.endsWith("/submit"))).toHaveLength(1);
			expect(outbound).toEqual([]);
		} finally {
			await server?.stop();
			if (providersUp) fixtures.stop();
			await rm(dir, { recursive: true, force: true });
		}
	});
}
