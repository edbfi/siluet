import { readFile, rm } from "node:fs/promises";
import { expect, type Page } from "@playwright/test";
import { sql } from "drizzle-orm";
import { openInstallation } from "../../src/lib/server/db/installation";
import { duplicateFrames, keyframeAcceptance } from "../../src/lib/shared/video-studio/keyframes";
import { createOwnerDirectory } from "../fixtures/owner-directory";
import { providerFixtureKeys, startProviderFixtures } from "../fixtures/provider-connections";
import { seedanceProvider } from "../fixtures/seedance-provider";
import { startStudio } from "./built-studio";
import { claimOwner, ownerRequest } from "./owner-session";
import { playsH264 } from "./saved-video-playback";
import { test } from "./studio-test";

// Two signed frames on one host. Nothing may read either URL.
// A maximal 63-character DNS label: a long signed-storage host must still fit 320 px.
const frameHost = "frames-sentinel-0123456789abcdef0123456789abcdef0123456789abcde.example.com";
const start = `https://${frameHost}/start.png?X-Amz-Signature=start-sentinel&X-Amz-Expires=900`;
const end = `https://${frameHost}/end.png?X-Amz-Signature=end-sentinel#t=1`;
const prompt = "A paper kite drifts from one frame to the next.";

async function reviewed(page: Page) {
	const response = page.waitForResponse((r) => new URL(r.url()).pathname === "/video/review");
	await page.getByRole("button", { name: "Review request" }).press("Enter");
	const text = await (await response).text();
	for (const secret of ["X-Amz-Signature", "start.png", "end.png", "sentinel&"])
		expect(text).not.toContain(secret);
	return JSON.parse(text) as { token: string; frames: string[]; blockers: string[] };
}

test("URL keyframes review by keyboard, queue once, save automatically and reopen offline", async ({
	page,
}) => {
	test.setTimeout(120_000);
	const directory = await createOwnerDirectory();
	const bytes = await readFile("tests/fixtures/video/h264-aac.mp4");
	const bodies: Record<string, unknown>[] = [];
	const fixture = startProviderFixtures(
		seedanceProvider(bytes, async (request) => {
			const body = await request.json();
			bodies.push(body);
			return body.client_business_id;
		}),
	);
	const browserReads: string[] = [];
	let server: Awaited<ReturnType<typeof startStudio>> | undefined;
	try {
		server = await startStudio(directory, "0", false, fixture.env);
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
		await page.getByRole("button", { name: "Check again: video models" }).press("Enter");
		await expect(page.getByText(/ToAPIs listed seedance-2-5 for this key/)).toBeVisible();

		const queue = page.getByRole("button", { name: "Queue 1 request" });
		const acceptance = page.getByRole("checkbox", { name: keyframeAcceptance });
		const startField = page.getByRole("textbox", { name: "Starting frame" });
		const endField = page.getByRole("textbox", { name: "Ending frame" });
		const frameList = page.getByRole("list", { name: "Frames" });
		let token = "";
		for (const width of [1100, 320]) {
			await page.setViewportSize({ width, height: 800 });
			await page.goto(`${origin}/video`);
			const promptField = page.getByRole("textbox", { name: "Prompt" });
			await promptField.fill(prompt);
			// The operation radios sit above Prompt; Create video keeps its ratio controls.
			await promptField.press("Tab");
			await expect(page.getByRole("radio", { name: "16:9", exact: true })).toBeFocused();
			await promptField.press("Shift+Tab");
			await expect(page.getByRole("radio", { name: "Create video" })).toBeFocused();
			await page.keyboard.press("ArrowRight");
			await expect(page.getByRole("radio", { name: "Animate a still" })).toBeChecked();
			await expect(page.getByText("Framing follows the starting frame.")).toBeVisible();
			await expect(page.getByRole("radio", { name: "16:9", exact: true })).toHaveCount(0);
			await expect(endField).toHaveCount(0);
			await page.keyboard.press("Tab");
			await expect(promptField).toBeFocused();
			await expect(promptField).toHaveValue(prompt);
			await page.keyboard.press("Tab");
			await expect(startField).toBeFocused();
			await page.keyboard.type(start);
			const one = await reviewed(page);
			expect(one.frames).toEqual([`Starting frame · ${frameHost}`]);
			await expect(page.getByText("Animate a still · Seedance 2.5 · ToAPIs · MP4")).toBeVisible();
			await expect(frameList.getByText(`Starting frame · ${frameHost}`)).toBeVisible();
			await acceptance.press("Space");
			await expect(queue).toBeEnabled();

			// A mode change clears acceptance, Review and the frames.
			await page.getByRole("radio", { name: "Animate a still" }).focus();
			await page.keyboard.press("ArrowRight");
			await expect(page.getByRole("radio", { name: "First and last frame" })).toBeChecked();
			await expect(queue).toHaveCount(0);
			await expect(startField).toHaveValue("");
			await startField.focus();
			await page.keyboard.type(start);
			await page.keyboard.press("Tab");
			await expect(endField).toBeFocused();
			await page.keyboard.type(start);
			const review = page.getByRole("button", { name: "Review request" });
			await expect(review).toBeDisabled();
			await expect(endField).toHaveAttribute("aria-invalid", "true");
			await expect(page.getByText(duplicateFrames)).toBeVisible();
			await endField.fill("");
			await endField.focus();
			await page.keyboard.type(end);
			await expect(review).toBeEnabled();
			const two = await reviewed(page);
			expect(two.frames).toEqual([`Starting frame · ${frameHost}`, `Ending frame · ${frameHost}`]);
			expect(two.blockers).toEqual([]);
			await expect(page.getByText("One clip, zero retries, zero uploads")).toBeVisible();
			await expect(page.getByText("1 potentially billable submission")).toBeVisible();
			await expect(page.getByText(/MP4 files up to 30 seconds, the provider's/)).toBeVisible();
			await expect(frameList.getByText(`Ending frame · ${frameHost}`)).toBeVisible();
			await acceptance.press("Space");
			await expect(queue).toBeEnabled();
			// A frame edit clears acceptance; a fresh Review leaves it unchecked.
			await endField.press("End");
			await page.keyboard.type("x");
			await expect(queue).toHaveCount(0);
			await page.keyboard.press("Backspace");
			const again = await reviewed(page);
			expect(again.token).not.toBe(two.token);
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
		await expect(job.getByText(/First and last frame/)).toBeVisible();
		await expect(job.getByText("Completed", { exact: true })).toBeVisible({ timeout: 25_000 });
		await expect(job.getByRole("link", { name: "Open saved video" })).toBeVisible({
			timeout: 20_000,
		});
		expect(bodies).toHaveLength(1);
		expect(bodies[0]).toEqual({
			model: "seedance-2-5",
			prompt,
			video_operation: "generate",
			duration: 5,
			aspect_ratio: "adaptive",
			resolution: "720p",
			generate_audio: true,
			output_format: "mp4",
			return_last_frame: false,
			disable_nsfw: false,
			image_with_roles: [
				{ url: start, role: "first_frame" },
				{ url: end, role: "last_frame" },
			],
			client_business_id: expect.stringMatching(/^siluet-/),
		});

		// Provider offline: the saved clip plays, seeks and downloads from the private Gallery.
		await server.stop();
		const diagnostics = server.diagnostics();
		server = undefined;
		fixture.stop();
		const db = await openInstallation(directory);
		try {
			const rows = JSON.stringify(await db.use((tx) => tx.all(sql`SELECT * FROM image_job`)));
			for (const secret of [frameHost, "X-Amz-Signature", prompt]) {
				expect(rows).not.toContain(secret);
				expect(diagnostics).not.toContain(secret);
			}
		} finally {
			await db.close();
		}
		server = await startStudio(directory, port, false, fixture.env);
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
		expect(browserReads.filter((url) => url.includes(frameHost))).toEqual([]);
		expect(fixture.requests.filter((request) => request.path === "/unexpected")).toEqual([]);
	} finally {
		await server?.stop();
		fixture.stop();
		await rm(directory, { recursive: true, force: true });
	}
});
