import { existsSync } from "node:fs";
import { copyFile, cp, mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect } from "@playwright/test";
import { seedanceOperation } from "../../src/lib/shared/media-catalog/registry";
import { videoDefaults } from "../../src/lib/shared/video-studio/seedance";
import { createOwnerDirectory } from "../fixtures/owner-directory";
import { providerFixtureKeys, startProviderFixtures } from "../fixtures/provider-connections";
import { seedanceProvider } from "../fixtures/seedance-provider";
import { undecodableH264Aac } from "../fixtures/video/mp4-boxes";
import { seedanceShape } from "../fixtures/video/real-clips";
import { startStudio } from "./built-studio";
import { claimOwner, ownerRequest } from "./owner-session";
import { seekThenPlay } from "./saved-video-playback";
import { test } from "./studio-test";

test("video-only key reviews once, saves one video and reopens its original bytes offline", async ({
	page,
	browser,
}) => {
	test.setTimeout(100_000);
	const directory = await createOwnerDirectory();
	// A clip laid out like Seedance output: C2PA box, media first and AAC priming.
	const bytes = seedanceShape();
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
			ownerRequest(page).post(origin + path, { data, headers: { origin: from } });
		const input = {
			draft,
			operationKey: seedanceOperation.key,
			count: 1,
			retryLimit: 0,
			acceptTerms: false,
		};
		await claimOwner(page, server, crypto.randomUUID());
		const other = await browser.newContext();
		try {
			for (const path of ["/video/review", "/video/queue"]) {
				expect(
					(await other.request.post(origin + path, { data: input, headers: { origin } })).status(),
				).toBe(401);
				expect((await post(path, input, "http://localhost:4444")).status()).toBe(403);
			}
			await ownerRequest(page).post(`${origin}/settings/providers?/connect`, {
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
				await expect(page.getByText(/MP4 files up to 30 seconds, the provider's/)).toBeVisible();
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
			// Siluet saves the clip without a click.
			await expect(page.getByRole("button", { name: "Save to Gallery" })).toHaveCount(0);
			await page.getByRole("link", { name: "Open saved video" }).click({ timeout: 20000 });
			const path = `/gallery/${jobId}`;
			const media = `${origin + path}/media`;
			// The viewer and the Gallery tile download the original clip under the short job id.
			const name = `siluet-video-${jobId.slice(0, 8)}.mp4`;
			for (const link of [
				() => page.getByRole("link", { name: "Download video" }),
				() => page.getByRole("link", { name: `Download video ${jobId.slice(0, 8)}` }),
			]) {
				const [file] = await Promise.all([page.waitForEvent("download"), link().press("Enter")]);
				expect(file.suggestedFilename()).toBe(name);
				expect(await readFile(await file.path())).toEqual(bytes);
				await page.goto(`${origin}/gallery`);
			}
			const before = fixture.requests.length;
			await server.stop();
			server = await startStudio(directory, port, false, fixture.env, release);
			await ownerRequest(page).post(`${origin}/settings/providers?/remove`, {
				headers: { origin, accept: "text/html" },
				form: { provider: "toapis" },
			});
			expect(await (await post("/video/queue", click)).json()).toEqual({ jobId });
			await page.goto(origin + path);
			const video = page.getByLabel("Saved video playback");
			await expect(video).toBeVisible();
			await seekThenPlay(page, video);
			// The saved clip's own headers keep it sandboxed and unframeable.
			const inline = await ownerRequest(page).get(media);
			expect(inline.headers()).toMatchObject({
				"content-type": "video/mp4",
				"cross-origin-resource-policy": "same-origin",
				"x-frame-options": "DENY",
				"x-content-type-options": "nosniff",
				"referrer-policy": "same-origin",
				"content-security-policy":
					"default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; media-src 'self'; sandbox allow-same-origin",
			});
			// Opened on its own, a media link carries no bearer and gets nothing.
			expect((await page.goto(media))?.status()).toBe(401);
			await page.goto(origin + path);
			expect(await (await ownerRequest(page).get(`${media}?download=1`)).body()).toEqual(bytes);
			const head = await ownerRequest(page).head(media, { headers: { range: "bytes=0-1" } });
			expect(head.status()).toBe(200);
			expect(head.headers()["content-length"]).toBe(String(bytes.length));
			for (const [range, start, end] of [
				["bytes=3-9", 3, 9],
				["bytes=32-", 32, bytes.length - 1],
				["bytes=-9", bytes.length - 9, bytes.length - 1],
			] as const) {
				const response = await ownerRequest(page).get(media, { headers: { range } });
				expect(response.status()).toBe(206);
				expect(response.headers()["content-range"]).toBe(`bytes ${start}-${end}/${bytes.length}`);
				expect(await response.body()).toEqual(bytes.subarray(start, end + 1));
			}
			expect(
				(
					await ownerRequest(page).get(media, { headers: { range: `bytes=${bytes.length}-` } })
				).status(),
			).toBe(416);
			for (const headers of [
				{ range: "bytes=1-2,5-7" },
				{ range: "seconds=2-" },
				{ "if-range": '"other"', range: "bytes=0-1" },
			] as Record<string, string>[])
				expect((await ownerRequest(page).get(media, { headers })).status()).toBe(200);
			for (const headers of [
				{ origin: "http://127.0.0.1:9999" },
				{ "sec-fetch-site": "same-site" },
			] as Record<string, string>[])
				expect((await ownerRequest(page).get(media, { headers })).status()).toBe(403);
			expect((await other.request.head(media, { maxRedirects: 0 })).status()).toBe(401);
			await page.getByRole("link", { name: "Remove from Gallery" }).press("Enter");
			await page.getByRole("button", { name: "Remove from Gallery" }).press("Enter");
			await expect(page).toHaveURL(`${origin}/gallery`);
			expect((await ownerRequest(page).get(media)).status()).toBe(404);
			expect((await page.goto(media))?.status()).toBe(401);
			await page.goto(`${origin}/gallery`);
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
		await claimOwner(page, server, crypto.randomUUID());
		await ownerRequest(page).post(`${origin}/settings/providers?/connect`, {
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
			ownerRequest(page).post(origin + path, { data, headers: { origin } });
		const review = await (await post("/video/review", { ...input, acceptTerms: false })).json();
		expect(review.blockers).toEqual([]);
		const { jobId } = await (
			await post("/video/queue", { ...input, token: review.token, acceptTerms: true })
		).json();
		await page.goto(`${origin}/jobs#job-${jobId}`);
		await expect(page.getByText("Completed", { exact: true })).toBeVisible({ timeout: 25000 });
		await page.getByRole("link", { name: "Open saved video" }).click({ timeout: 20000 });
		const note = page.getByRole("status").filter({
			hasText: "This browser can't play this video. Download it to open it in another player.",
		});
		const video = page.getByLabel("Saved video playback");
		// The clip arrives as a blob; ask it to play without waiting on a promise an engine may
		// leave pending for undecodable media.
		await expect(video).toHaveAttribute("src", /^blob:/);
		await video.evaluate((v: HTMLVideoElement) => {
			v.play().catch(() => {});
		});
		await expect(note).toBeVisible();
		const download = page.getByRole("link", { name: "Download video" });
		await expect(download).toBeVisible();
		const media = await ownerRequest(page).get(origin + (await download.getAttribute("href")));
		expect(await media.body()).toEqual(bytes);
	} finally {
		await server?.stop();
		fixture.stop();
		await rm(directory, { recursive: true, force: true });
	}
});
