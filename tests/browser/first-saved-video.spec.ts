import { existsSync } from "node:fs";
import { copyFile, cp, mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { seedanceOperation } from "../../src/lib/shared/media-catalog/registry";
import { videoDefaults } from "../../src/lib/shared/video-studio/seedance";
import { createOwnerDirectory } from "../fixtures/owner-directory";
import { providerFixtureKeys, startProviderFixtures } from "../fixtures/provider-connections";
import { undecodableH264Aac } from "../fixtures/video/mp4-boxes";
import { startStudio } from "./built-studio";

/** ToAPIs Seedance fixtures: one accepted task that completes with `bytes` at a public media URL. */
function seedanceProvider(bytes: Buffer, submit: (request: Request) => Promise<string>) {
	return async (request: Request, path: string) => {
		if (path === "/toapis/video-models")
			return Response.json({ success: true, object: "list", data: [{ id: "seedance-2-5" }] });
		if (path === "/toapis/video-submit")
			return Response.json({
				object: "generation.task",
				id: "clip_1",
				model: "seedance-2-5",
				client_business_id: await submit(request),
				status: "queued",
			});
		if (path === "/toapis/video-status/clip_1")
			return Response.json({
				object: "generation.task",
				id: "clip_1",
				model: "seedance-2-5",
				status: "completed",
				progress: 100,
				billing: { status: "settled", credits: "7", cost_usd: "0.035" },
				result: {
					type: "video",
					data: [{ url: "https://93.184.216.34/result/video?key=secret-result" }],
				},
			});
		if (path === "/media/video") {
			expect(request.headers.has("authorization")).toBe(false);
			expect(request.headers.has("cookie")).toBe(false);
			return new Response(new Uint8Array(bytes));
		}
		return null;
	};
}

test("video-only key reviews once, saves one video and reopens its original bytes offline", async ({
	page,
	browser,
}) => {
	test.setTimeout(100_000);
	const directory = await createOwnerDirectory();
	const bytes = await readFile("tests/fixtures/video/h264-aac.mp4");
	const prompt = "A blue clock rotates slowly.";
	const draft = { ...videoDefaults, prompt, aspect_ratio: "9:16" };
	let posts = 0;
	const fixture = startProviderFixtures(
		seedanceProvider(bytes, async (request) => {
			posts++;
			const body = await request.json();
			const business = body.client_business_id;
			expect(request.headers.get("authorization")).toBe(`Bearer ${providerFixtureKeys.restricted}`);
			expect(request.method).toBe("POST");
			expect(body).toEqual({
				...draft,
				client_business_id: expect.stringMatching(/^siluet-[0-9a-f-]{14}4[0-9a-f-]{21}$/),
				model: "seedance-2-5",
				video_operation: "generate",
				output_format: "mp4",
				return_last_frame: false,
				disable_nsfw: false,
			});
			return business;
		}),
	);
	const release = await mkdtemp(join(tmpdir(), "siluet-video-release-"));
	let server: Awaited<ReturnType<typeof startStudio>> | undefined;
	try {
		await cp("build", join(release, "build"), { recursive: true });
		await mkdir(join(release, "scripts"));
		await copyFile("scripts/start.ts", join(release, "scripts/start.ts"));
		await copyFile("package.json", join(release, "package.json"));
		await symlink(resolve("node_modules"), join(release, "node_modules"));
		// The release ships no video specimen or native tool.
		expect(existsSync(join(release, "build/server/qualification.mp4"))).toBe(false);
		server = await startStudio(directory, "0", false, fixture.env, release);
		const { origin, port } = server.origin;
		await expect.poll(server.token).not.toBe("");
		const post = (path: string, data: unknown, from = origin) =>
			page.request.post(origin + path, { data, headers: { origin: from } });
		const input = {
			draft,
			operationKey: seedanceOperation.key,
			count: 1,
			retryLimit: 0,
			acceptTerms: false,
		};
		await page.request.post(`${origin}/setup`, {
			headers: { origin, accept: "text/html" },
			form: { token: server.token(), username: "creator", password: crypto.randomUUID() },
		});
		const other = await browser.newContext();
		try {
			for (const path of ["/video/review", "/video/queue"]) {
				expect(
					(await other.request.post(origin + path, { data: input, headers: { origin } })).status(),
				).toBe(401);
				expect((await post(path, input, "http://localhost:4444")).status()).toBe(403);
			}
			await page.request.post(`${origin}/settings/providers?/connect`, {
				headers: { origin, accept: "text/html" },
				form: { provider: "toapis", key: providerFixtureKeys.restricted },
			});
			expect((await (await post("/video/review", input)).json()).blockers.join(" ")).toContain(
				"Check video access",
			);
			await page.goto(`${origin}/settings/providers?provider=toapis`);
			await page.getByRole("button", { name: "Check video access" }).press("Enter");
			await expect(page.getByText(/Seedance 2.5 was listed/)).toHaveCount(1);
			await expect(
				page.getByRole("status").filter({ hasText: /Seedance 2.5 was listed/ }),
			).toBeVisible();
			await page.goto(`${origin}/video`);
			let review: { token: string; blockers: string[] } | undefined;
			for (const width of [1100, 320]) {
				await page.setViewportSize({ width, height: 800 });
				const promptField = page.getByRole("textbox", { name: "Prompt" });
				await promptField.fill(prompt);
				await promptField.press("Tab");
				const landscape = page.getByRole("radio", { name: "16:9", exact: true });
				if (width === 320) await page.keyboard.press("ArrowLeft");
				await expect(landscape).toBeFocused();
				await page.keyboard.press("ArrowRight");
				await expect(page.getByRole("radio", { name: "9:16", exact: true })).toBeChecked();
				await expect(page.getByText("Framing · 9:16")).toBeVisible();
				const reviewed = page.waitForResponse((r) => new URL(r.url()).pathname === "/video/review");
				await page.getByRole("button", { name: "Review request" }).press("Enter");
				review = await (await reviewed).json();
				await expect(page.getByText("1 potentially billable submission")).toBeVisible();
				expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
					true,
				);
			}

			if (!review) throw new Error("Review was unavailable.");
			const click = { ...input, token: review.token, acceptTerms: true };
			expect((await post("/video/queue", { ...click, acceptTerms: false })).status()).toBe(400);
			expect(
				(
					await post("/video/queue", { ...click, draft: { ...draft, prompt: "replacement" } })
				).status(),
			).toBe(400);
			expect(review.blockers).toEqual([]);
			const button = page.getByRole("button", { name: "Queue 1 request" });
			await expect(button).toBeDisabled();
			const acceptance = page.getByRole("checkbox", { name: /I accept/ });
			await acceptance.press("Space");
			await expect(button).toBeEnabled();
			const replacement = page.waitForResponse(
				(r) => new URL(r.url()).pathname === "/video/review",
			);
			await page.getByRole("button", { name: "Review request" }).press("Enter");
			const nextReview = await (await replacement).json();
			expect(nextReview.token).not.toBe(click.token);
			click.token = nextReview.token;
			await expect(acceptance).not.toBeChecked();
			await expect(button).toBeDisabled();
			await acceptance.press("Space");
			const response = page.waitForResponse((r) => new URL(r.url()).pathname === "/video/queue");
			const [duplicate] = await Promise.all([post("/video/queue", click), button.press("Enter")]);
			const { jobId } = await (await response).json();
			expect(await duplicate.json()).toEqual({ jobId });
			expect(posts).toBe(1);
			await expect(page).toHaveURL(`${origin}/jobs#job-${jobId}`);
			await expect(page.getByText("Completed", { exact: true })).toBeVisible({ timeout: 25000 });
			const save = page.getByRole("button", { name: "Save to Gallery" });
			await expect(save).toBeEnabled({ timeout: 20000 });
			await save.press("Enter");
			await page.getByRole("link", { name: "Open saved video" }).click();
			const path = `/gallery/${jobId}`;
			const media = `${origin + path}/media`;
			const before = fixture.requests.length;
			await server.stop();
			server = await startStudio(directory, port, false, fixture.env, release);
			await page.request.post(`${origin}/settings/providers?/remove`, {
				headers: { origin, accept: "text/html" },
				form: { provider: "toapis" },
			});
			expect(await (await post("/video/queue", click)).json()).toEqual({ jobId });
			await page.goto(origin + path);
			const video = page.getByLabel("Saved video playback");
			await expect(video).toBeVisible();
			expect(await video.evaluate((v: HTMLVideoElement) => v.autoplay)).toBe(false);
			await video.focus();
			await video.press("Space");
			await expect
				.poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime))
				.toBeGreaterThan(0);
			await video.press("ArrowRight");
			await expect
				.poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime))
				.toBeGreaterThan(1);
			expect(await (await page.request.get(`${media}?download=1`)).body()).toEqual(bytes);
			const head = await page.request.head(media, { headers: { range: "bytes=0-1" } });
			expect(head.status()).toBe(200);
			expect(head.headers()["content-length"]).toBe(String(bytes.length));
			for (const [range, start, end] of [
				["bytes=3-9", 3, 9],
				["bytes=32-", 32, bytes.length - 1],
				["bytes=-9", bytes.length - 9, bytes.length - 1],
			] as const) {
				const response = await page.request.get(media, { headers: { range } });
				expect(response.status()).toBe(206);
				expect(response.headers()["content-range"]).toBe(`bytes ${start}-${end}/${bytes.length}`);
				expect(await response.body()).toEqual(bytes.subarray(start, end + 1));
			}
			expect(
				(await page.request.get(media, { headers: { range: `bytes=${bytes.length}-` } })).status(),
			).toBe(416);
			for (const headers of [
				{ range: "bytes=1-2,5-7" },
				{ range: "seconds=2-" },
				{ "if-range": '"other"', range: "bytes=0-1" },
			] as Record<string, string>[])
				expect((await page.request.get(media, { headers })).status()).toBe(200);
			for (const headers of [
				{ origin: "http://127.0.0.1:9999" },
				{ "sec-fetch-site": "same-site" },
			] as Record<string, string>[])
				expect((await page.request.get(media, { headers })).status()).toBe(403);
			expect((await other.request.head(media, { maxRedirects: 0 })).status()).toBe(303);
			await page.getByRole("link", { name: "Remove from Gallery" }).press("Enter");
			await page.getByRole("button", { name: "Remove from Gallery" }).press("Enter");
			await expect(page).toHaveURL(`${origin}/gallery`);
			expect((await page.request.get(media)).status()).toBe(404);
			expect(fixture.requests.length).toBe(before);
			expect(server.diagnostics()).not.toContain("secret-result");
		} finally {
			await other.close();
		}
	} finally {
		await server?.stop();
		fixture.stop();
		await rm(directory, { recursive: true, force: true });
		await rm(release, { recursive: true, force: true });
	}
});

test("Gallery says when this browser cannot play a saved clip and keeps Download", async ({
	page,
}) => {
	test.setTimeout(60_000);
	const directory = await createOwnerDirectory();
	const bytes = undecodableH264Aac();
	const fixture = startProviderFixtures(
		seedanceProvider(bytes, async (request) => (await request.json()).client_business_id),
	);
	let server: Awaited<ReturnType<typeof startStudio>> | undefined;
	try {
		server = await startStudio(directory, "0", false, fixture.env);
		const { origin } = server.origin;
		await expect.poll(server.token).not.toBe("");
		await page.request.post(`${origin}/setup`, {
			headers: { origin, accept: "text/html" },
			form: { token: server.token(), username: "creator", password: crypto.randomUUID() },
		});
		await page.request.post(`${origin}/settings/providers?/connect`, {
			headers: { origin, accept: "text/html" },
			form: { provider: "toapis", key: providerFixtureKeys.restricted },
		});
		await page.goto(`${origin}/settings/providers?provider=toapis`);
		await page.getByRole("button", { name: "Check video access" }).click();
		await expect(page.getByText(/Seedance 2.5 was listed/).first()).toBeVisible();
		const input = {
			draft: { ...videoDefaults, prompt: "A red ball bounces." },
			operationKey: seedanceOperation.key,
			count: 1,
			retryLimit: 0,
		};
		const post = (path: string, data: unknown) =>
			page.request.post(origin + path, { data, headers: { origin } });
		const review = await (await post("/video/review", { ...input, acceptTerms: false })).json();
		expect(review.blockers).toEqual([]);
		const { jobId } = await (
			await post("/video/queue", { ...input, token: review.token, acceptTerms: true })
		).json();
		await page.goto(`${origin}/jobs#job-${jobId}`);
		await expect(page.getByText("Completed", { exact: true })).toBeVisible({ timeout: 25000 });
		const save = page.getByRole("button", { name: "Save to Gallery" });
		await expect(save).toBeEnabled({ timeout: 20000 });
		await save.click();
		await page.getByRole("link", { name: "Open saved video" }).click();
		const note = page.getByRole("status").filter({
			hasText: "This browser can't play this video. Download it to open it in another player.",
		});
		await expect(note).toHaveCount(0);
		const video = page.getByLabel("Saved video playback");
		await video.evaluate((v: HTMLVideoElement) => v.play().catch(() => {}));
		await expect(note).toBeVisible();
		const download = page.getByRole("link", { name: "Download video" });
		await expect(download).toBeVisible();
		const media = await page.request.get(origin + (await download.getAttribute("href")));
		expect(await media.body()).toEqual(bytes);
	} finally {
		await server?.stop();
		fixture.stop();
		await rm(directory, { recursive: true, force: true });
	}
});
