import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, type Page } from "@playwright/test";
import { sql } from "drizzle-orm";
import { openInstallation } from "../../src/lib/server/db/installation";
import { seedanceEditOperation } from "../../src/lib/shared/media-catalog/registry";
import { videoReviewDisclosures } from "../../src/lib/shared/video-studio/request";
import { editAcceptance, sourceClipHint } from "../../src/lib/shared/video-studio/source-edit";
import { createOwnerDirectory } from "../fixtures/owner-directory";
import { providerFixtureKeys, startProviderFixtures } from "../fixtures/provider-connections";
import { writeReviewPricing } from "../fixtures/review-pricing";
import { seedanceProvider } from "../fixtures/seedance-provider";
import { startStudio } from "./built-studio";
import { claimOwner, ownerRequest } from "./owner-session";
import { playsH264 } from "./saved-video-playback";
import { test } from "./studio-test";

// One signed source clip on a maximal 63-character DNS label. Nothing may read or resolve it.
const sourceHost = "source-sentinel-0123456789abcdef0123456789abcdef0123456789abcde.example.com";
const sourcePath = "/private/take-3.mp4";
const sourceQuery = "?X-Amz-Signature=source-sentinel&X-Amz-Expires=900";
const sourceFragment = "#t=2";
const source = `https://${sourceHost}${sourcePath}${sourceQuery}${sourceFragment}`;
const prompt = "Turn the afternoon into a blue-hour dusk.";

async function reviewed(page: Page) {
	const response = page.waitForResponse((r) => new URL(r.url()).pathname === "/video/review");
	await page.getByRole("button", { name: "Review request" }).press("Enter");
	const text = await (await response).text();
	for (const secret of [source, sourcePath, "take-3", "X-Amz-Signature", sourceFragment])
		expect(text).not.toContain(secret);
	return JSON.parse(text) as { token: string; frames: string[]; blockers: string[] };
}

test("a source-video edit reviews by keyboard, queues once, saves automatically and reopens offline", async ({
	page,
}) => {
	test.setTimeout(120_000);
	const directory = await createOwnerDirectory();
	const cacheHome = await mkdtemp(join(tmpdir(), "siluet-source-edit-pricing-"));
	await writeReviewPricing(cacheHome, 0);
	const bytes = await readFile("tests/fixtures/video/h264-aac.mp4");
	const bodies: Record<string, unknown>[] = [];
	const fixture = startProviderFixtures(
		seedanceProvider(bytes, async (request) => {
			const body = await request.json();
			bodies.push(body);
			return body.client_business_id;
		}),
	);
	const env = { ...fixture.env, XDG_CACHE_HOME: cacheHome };
	const browserReads: string[] = [];
	let server: Awaited<ReturnType<typeof startStudio>> | undefined;
	try {
		server = await startStudio(directory, "0", false, env);
		const { origin, port } = server.origin;
		await page.route("**/*", (route) => {
			const url = route.request().url();
			if (new URL(url).origin === origin) return route.continue();
			browserReads.push(url);
			return route.abort();
		});
		await expect.poll(server.token).not.toBe("");
		await claimOwner(page, server, crypto.randomUUID());
		await ownerRequest(page).post(`${origin}/settings/providers?/connect`, {
			headers: { origin, accept: "text/html" },
			form: { provider: "toapis", key: providerFixtureKeys.restricted },
		});
		await page.goto(`${origin}/settings/providers?provider=toapis`);
		await page.getByRole("button", { name: "Check video models again" }).press("Enter");
		await expect(page.getByText(/ToAPIs listed seedance-2-5 for this key/)).toBeVisible();

		const queue = page.getByRole("button", { name: "Queue 1 request" });
		const acceptance = page.getByRole("checkbox", { name: editAcceptance });
		const sourceField = page.getByRole("textbox", { name: "Source clip" });
		const sourceList = page.getByRole("list", { name: "Source clip" });
		const label = `Source clip · ${sourceHost}`;
		let token = "";
		for (const width of [1100, 320]) {
			await page.setViewportSize({ width, height: 800 });
			await page.goto(`${origin}/video`);
			const promptField = page.getByRole("textbox", { name: "Prompt" });
			await promptField.fill(prompt);
			await promptField.press("Shift+Tab");
			await expect(page.getByRole("radio", { name: "Create video" })).toBeFocused();
			for (let step = 0; step < 3; step++) await page.keyboard.press("ArrowRight");
			await expect(page.getByRole("radio", { name: "Edit video" })).toBeChecked();
			// Length and framing follow the source: no Duration or Aspect ratio controls.
			await expect(page.getByText("Edit length and framing follow the source clip.")).toBeVisible();
			await expect(page.getByText(sourceClipHint)).toBeVisible();
			await expect(page.getByRole("combobox", { name: "Duration (seconds)" })).toHaveCount(0);
			await expect(page.getByRole("group", { name: "Aspect ratio" })).toHaveCount(0);
			await expect(page.getByRole("radio", { name: "16:9", exact: true })).toHaveCount(0);
			await page.keyboard.press("Tab");
			await expect(promptField).toBeFocused();
			await expect(promptField).toHaveValue(prompt);
			await page.keyboard.press("Tab");
			await expect(sourceField).toBeFocused();
			await page.keyboard.type(source);
			const first = await reviewed(page);
			expect(first.frames).toEqual([label]);
			expect(first.blockers).toEqual([]);
			await expect(page.getByText("Edit video · Seedance 2.5 · ToAPIs · MP4")).toBeVisible();
			await expect(page.getByText("One clip, zero retries, zero uploads")).toBeVisible();
			await expect(page.getByText("1 potentially billable submission")).toBeVisible();
			await expect(sourceList.getByText(label)).toBeVisible();
			await expect(page.getByText(/\$6 per million total tokens/)).toBeVisible();
			// The edit's own disclosures, then its upstream Save limit.
			for (const disclosure of videoReviewDisclosures(seedanceEditOperation))
				await expect(page.getByText(disclosure, { exact: true })).toBeVisible();
			await expect(
				page.getByText(
					/up to 30 seconds, the upstream model's documented maximum for this mode, unverified on this route/,
				),
			).toBeVisible();
			await acceptance.press("Space");
			await expect(queue).toBeEnabled();

			// A URL change clears acceptance and Review; a fresh Review leaves it unchecked.
			await sourceField.press("End");
			await page.keyboard.type("x");
			await expect(queue).toHaveCount(0);
			await page.keyboard.press("Backspace");
			const second = await reviewed(page);
			expect(second.token).not.toBe(first.token);
			await expect(acceptance).not.toBeChecked();
			await acceptance.press("Space");
			await expect(queue).toBeEnabled();

			// A mode change clears acceptance, Review and the source.
			await page.getByRole("radio", { name: "Edit video" }).focus();
			await page.keyboard.press("ArrowLeft");
			await expect(page.getByRole("radio", { name: "First and last frame" })).toBeChecked();
			await expect(queue).toHaveCount(0);
			await page.keyboard.press("ArrowRight");
			await expect(page.getByRole("radio", { name: "Edit video" })).toBeChecked();
			await expect(sourceField).toHaveValue("");
			await sourceField.focus();
			await page.keyboard.type(source);
			const again = await reviewed(page);
			await expect(acceptance).not.toBeChecked();
			await expect(queue).toBeDisabled();
			token = again.token;
			expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
				true,
			);
		}

		await acceptance.press("Space");
		const queued = page.waitForResponse((r) => new URL(r.url()).pathname === "/video/queue");
		await queue.press("Enter");
		const { jobId } = await (await queued).json();
		expect(token).not.toBe("");
		await expect(page).toHaveURL(`${origin}/jobs#job-${jobId}`);
		const job = page.locator(`#job-${jobId}`);
		await expect(job.getByText(/Edit video/)).toBeVisible();
		await expect(job.getByText("Completed", { exact: true })).toBeVisible({ timeout: 25_000 });
		await expect(job.getByRole("link", { name: "Open saved video" })).toBeVisible({
			timeout: 20_000,
		});
		expect(bodies).toHaveLength(1);
		expect(bodies[0]).toEqual({
			model: "seedance-2-5",
			prompt,
			video_operation: "edit",
			duration: -1,
			aspect_ratio: "adaptive",
			resolution: "720p",
			generate_audio: true,
			output_format: "mp4",
			return_last_frame: false,
			disable_nsfw: false,
			video_with_roles: [{ url: source, role: "reference_video" }],
			client_business_id: expect.stringMatching(/^siluet-/),
		});
		expect(bodies[0]).not.toHaveProperty("image_with_roles");
		const storage = await page.evaluate(() => JSON.stringify([localStorage, sessionStorage]));
		for (const secret of [sourceHost, "X-Amz-Signature", "take-3"])
			expect(storage).not.toContain(secret);

		// Provider offline: the saved clip plays, seeks and downloads from the private Gallery.
		await server.stop();
		const diagnostics = server.diagnostics();
		server = undefined;
		fixture.stop();
		const db = await openInstallation(directory);
		try {
			const rows = JSON.stringify(await db.use((tx) => tx.all(sql`SELECT * FROM image_job`)));
			for (const secret of [sourceHost, "X-Amz-Signature", "take-3", prompt]) {
				expect(rows).not.toContain(secret);
				expect(diagnostics).not.toContain(secret);
			}
		} finally {
			await db.close();
		}
		server = await startStudio(directory, port, false, env);
		await page.goto(`${origin}/gallery/${jobId}`);
		const video = page.getByLabel("Saved video playback");
		await expect(video).toBeVisible();
		// Playwright's Linux Firefox has no H.264 decoder; Download below still proves the bytes.
		if (await playsH264(video)) {
			await video.focus();
			await video.press("Space");
			await expect
				.poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime))
				.toBeGreaterThan(0);
			await video.press("ArrowRight");
			await expect
				.poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime))
				.toBeGreaterThan(1);
		}
		const [file] = await Promise.all([
			page.waitForEvent("download"),
			page.getByRole("link", { name: "Download video" }).press("Enter"),
		]);
		expect(await readFile(await file.path())).toEqual(bytes);
		// Zero source-host reads from the browser, and zero server fetches or DNS resolutions.
		expect(browserReads.filter((url) => url.includes(sourceHost))).toEqual([]);
		expect(fixture.requests.filter((request) => request.path === "/unexpected")).toEqual([]);
		// Nothing in this journey resolves a name, so any lookup at all is a regression.
		expect(fixture.requests.filter((request) => request.path.startsWith("/dns/"))).toEqual([]);
		expect(fixture.requests.filter((request) => request.path.includes("source-sentinel"))).toEqual(
			[],
		);
	} finally {
		await server?.stop();
		fixture.stop();
		await rm(directory, { recursive: true, force: true });
		await rm(cacheHome, { recursive: true, force: true });
	}
});
