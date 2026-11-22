import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type APIResponse, expect, type Page, test } from "@playwright/test";
import { pricingCachePath } from "../../src/lib/server/services/pricing/local-feed";
import {
	createSeedreamDraft,
	type SeedreamProvider,
} from "../../src/lib/shared/image-studio/seedream";
import { createOwnerDirectory } from "../fixtures/owner-directory";
import { providerFixtureKeys } from "../fixtures/provider-connections";
import {
	editedImagePath,
	editedImageSignature,
	editedPng,
	referenceEditFixtures,
	referenceFragmentMarker,
	referenceHost,
	referencePathMarker,
	referenceQueryMarker,
	signedReference,
} from "../fixtures/reference-edit";
import { writeReviewPricing } from "../fixtures/review-pricing";
import { startStudio } from "./built-studio";

const promptMarker = "private-edit-prompt";
const promptUrlMarker = "private-prompt-url";
const prompt = `Move the sculpture beside ${promptMarker}. See <https://prompt.example.test/?sig=${promptUrlMarker}>.`;
const updatedSignature = "private-updated-signature";
const changedReference = signedReference.replace(referenceQueryMarker, updatedSignature);

function edit(provider: SeedreamProvider, url = signedReference) {
	return {
		draft: {
			...createSeedreamDraft(provider, "edit"),
			prompt,
			references: [{ kind: "url", url: `  ${url}  ` }],
		},
		count: 1,
		retryLimit: 0,
		acceptUnknown: false,
	};
}

function providerPayload(provider: SeedreamProvider, reference = signedReference, text = prompt) {
	const output = { background: "auto", output_format: "png" };
	return provider === "poyo"
		? {
				model: "seedream-5.5",
				input: {
					prompt: text,
					size: "auto",
					resolution: "2K",
					...output,
					enable_safety_checker: false,
					image_urls: [reference],
				},
			}
		: {
				model: "doubao-seedream-5-5",
				prompt: text,
				size: "2K",
				disable_nsfw: false,
				metadata: { ...output, watermark: false },
				image_urls: [reference],
			};
}

async function readReview(response: APIResponse) {
	expect(response.status()).toBe(200);
	const review = (await response.json()) as { token: string; requiresConsent: boolean };
	expect(review).toMatchObject({
		token: expect.any(String),
		requiresConsent: expect.any(Boolean),
	});
	return review;
}

type Outcome = NonNullable<Parameters<typeof referenceEditFixtures>[1]>;
type Studio = Awaited<ReturnType<typeof startStudio>>;

async function withEditStudio(
	page: Page,
	provider: SeedreamProvider,
	outcome: Outcome,
	run: (context: {
		origin: string;
		cacheHome: string;
		rates: Awaited<ReturnType<typeof writeReviewPricing>>;
		fixtures: ReturnType<typeof referenceEditFixtures>;
		post: (path: string, data: unknown, from?: string) => ReturnType<Page["request"]["post"]>;
		restart: () => Promise<void>;
		assertPrivate: (includePage?: boolean) => Promise<void>;
		assertOneSubmission: () => void;
	}) => Promise<void>,
) {
	const dir = await createOwnerDirectory();
	const fixtures = referenceEditFixtures(provider, outcome);
	const cacheHome = await mkdtemp(join(tmpdir(), "siluet-reference-pricing-"));
	const env = { ...fixtures.env, XDG_CACHE_HOME: cacheHome };
	let studio: Studio | undefined;
	try {
		const rates = await writeReviewPricing(cacheHome, 0);
		studio = await startStudio(dir, "0", false, env);
		const origin = studio.origin.origin;
		const port = studio.origin.port;
		const browserRequests: string[] = [];
		const browserMessages: string[] = [];
		page.on("console", (message) => browserMessages.push(message.text()));
		page.on("pageerror", (error) => browserMessages.push(error.message));
		await page.route("**/*", (route) => {
			const url = route.request().url();
			if (new URL(url).origin === origin) return route.continue();
			browserRequests.push(url);
			return route.abort();
		});
		await expect.poll(studio.token).not.toBe("");
		const setup = await page.request.post(`${origin}/setup`, {
			headers: { origin, accept: "text/html" },
			form: { token: studio.token(), username: "creator", password: crypto.randomUUID() },
			maxRedirects: 0,
		});
		expect(setup.status()).toBe(303);
		const connected = await page.request.post(`${origin}/settings/providers?/connect`, {
			headers: { origin, accept: "text/html" },
			form: { provider, key: providerFixtureKeys[provider] },
		});
		expect(connected.ok()).toBe(true);

		function assertRedacted(value: string) {
			for (const marker of [
				referenceHost,
				referencePathMarker,
				referenceQueryMarker,
				referenceFragmentMarker,
				updatedSignature,
				promptMarker,
				promptUrlMarker,
				editedImageSignature,
				providerFixtureKeys[provider],
			]) {
				expect(value).not.toContain(marker);
			}
		}
		const assertPrivate = async (includePage = true) => {
			assertRedacted(studio?.diagnostics() ?? "");
			assertRedacted(browserMessages.join("\n"));
			const { origins } = await page.context().storageState({ indexedDB: true });
			assertRedacted(JSON.stringify(origins));
			assertRedacted(
				await page.evaluate(async () =>
					JSON.stringify([
						sessionStorage,
						...(await Promise.all(
							(
								await caches.keys()
							).map(async (key) => {
								const cache = await caches.open(key);
								return Promise.all(
									(await cache.keys()).map(async (request) => [
										request.url,
										await (await cache.match(request))?.text(),
									]),
								);
							}),
						)),
					]),
				),
			);
			if (includePage) assertRedacted(await page.content());
			expect(browserRequests).toEqual([]);
			expect(fixtures.requests.filter(({ path }) => path === "/unexpected")).toEqual([]);
		};
		await run({
			origin,
			cacheHome,
			rates,
			fixtures,
			post: (path, data, from = origin) =>
				page.request.post(origin + path, { data, headers: { origin: from } }),
			async restart() {
				await studio?.stop();
				assertRedacted(studio?.diagnostics() ?? "");
				studio = undefined;
				const paths = await readdir(dir, { recursive: true });
				expect(paths).toContain("studio.db");
				assertRedacted(paths.join("\n"));
				for (const file of paths.filter((file) => file.startsWith("studio.db"))) {
					assertRedacted((await readFile(join(dir, file))).toString("latin1"));
				}
				studio = await startStudio(dir, port, false, env);
			},
			assertPrivate,
			assertOneSubmission() {
				expect(fixtures.requests.filter(({ path }) => path.endsWith("/submit"))).toEqual([
					{ path: `/${provider}/submit`, method: "POST", key: providerFixtureKeys[provider] },
				]);
			},
		});
	} finally {
		await studio?.stop();
		await fixtures.stop();
		await rm(dir, { recursive: true, force: true });
		await rm(cacheHome, { recursive: true, force: true });
	}
}

async function chooseReference(page: Page, url: string) {
	await page.getByText("Use a URL", { exact: true }).first().press("Enter");
	const field = page.getByRole("textbox", { name: "HTTP or HTTPS URL for reference image 1" });
	await field.fill(`  ${url}  `);
	await field.press("Enter");
}

for (const provider of ["poyo", "toapis"] as const) {
	test(`${provider} reviews, queues once and saves distinct output for offline reopening`, async ({
		page,
	}) => {
		test.setTimeout(75_000);
		await withEditStudio(
			page,
			provider,
			provider === "toapis" ? "download-fails-once" : "completed",
			async ({ origin, rates, fixtures, restart, assertPrivate, assertOneSubmission }) => {
				const beforeReview = fixtures.requests.length;
				await page.clock.setFixedTime(new Date(rates.observedMs + 60_000));
				await page.setViewportSize({ width: 320, height: 760 });
				await page.goto(`${origin}/image`);
				await page.getByRole("textbox", { name: "Prompt", exact: true }).fill(prompt);
				await page.getByLabel("Operation", { exact: true }).selectOption("edit");
				await chooseReference(page, provider === "poyo" ? signedReference : changedReference);
				const review = page.getByRole("region", { name: "Review request", exact: true });
				const facts = review.getByRole("tabpanel", { name: "Review", exact: true });
				const inspect = review.getByRole("button", { name: "Review request", exact: true });
				const queue = review.getByRole("button", { name: "Queue 1 request", exact: true });
				const consent = review.getByRole("checkbox", { name: /unknown/i });
				await inspect.press("Enter");
				await expect(inspect).toHaveCount(0);
				if (provider === "toapis") {
					await expect(consent).toHaveAccessibleName(/fallback/i);
					await expect(queue).toBeDisabled();
					await consent.press("Space");
					await expect(consent).toBeChecked();
					await chooseReference(page, signedReference);
					await expect(inspect).toBeEnabled();
					await expect(queue).toBeDisabled();
					await inspect.press("Enter");
					await expect(consent).not.toBeChecked();
					await expect(queue).toBeDisabled();
					await consent.press("Space");
				}
				await expect(facts).toContainText(referenceHost);
				const disclosure = facts.getByRole("list", { name: "Provider disclosure" });
				for (const text of [
					/full reference URL/i,
					/path/i,
					/query with any signature/i,
					/fragment/i,
					/upstream model services/i,
					/copy.*after the link expires/i,
				])
					await expect(disclosure).toContainText(text);
				await expect(disclosure).toContainText(
					provider === "poyo" ? /three months|3 months/i : /90 days/i,
				);
				await expect(disclosure).toContainText(
					/fetched reference images is (unknown|unspecified)/i,
				);
				if (provider === "toapis") await expect(disclosure).toContainText(/through a fallback/i);
				await expect(facts.locator("[data-studio-price]")).toContainText(
					provider === "poyo" ? "8.6 Poyo.ai credits" : "5.6 ToAPIs credits",
				);
				await expect(facts.locator("[data-studio-price]")).toContainText(
					rates.observedAt.slice(0, 10),
				);

				await review.getByRole("tab", { name: "Outgoing request" }).press("Enter");
				const outgoing = review.getByRole("tabpanel", { name: "Outgoing request" });
				expect(JSON.parse((await outgoing.locator("pre code").textContent()) ?? "")).toEqual(
					providerPayload(
						provider,
						"[remote URL hidden]",
						prompt.replace(/<.*>/, "<[URL hidden]>"),
					),
				);
				await assertPrivate(false);
				expect(fixtures.requests.slice(beforeReview)).toEqual([]);

				await review.getByRole("tab", { name: "Review", exact: true }).press("Enter");
				expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
					320,
				);
				await queue.press("Enter");
				await expect(page).toHaveURL(/\/jobs/);
				const job = page.getByRole("article");
				await expect(job.getByText("Completed", { exact: true })).toBeVisible({ timeout: 20_000 });
				expect(fixtures.submissions).toEqual([providerPayload(provider)]);
				assertOneSubmission();
				await assertPrivate();
				expect(fixtures.requests.filter(({ path }) => path === editedImagePath)).toEqual([]);
				const save = job.getByRole("button", { name: "Save to Gallery" });
				await expect(save).toBeEnabled({ timeout: 20_000 });
				await save.press("Enter");
				const open = job.getByRole("link", { name: "Open saved image" });
				if (provider === "toapis") {
					await expect(job.getByText(/retry Save on this job/)).toBeVisible();
					await expect(job.getByText("Completed", { exact: true })).toBeVisible();
					await expect(open).toHaveCount(0);
					await expect(save).toBeEnabled({ timeout: 20_000 });
					await save.press("Enter");
				}
				await expect(open).toBeVisible();
				const path = await open.getAttribute("href");
				if (!path) throw new Error("Missing Gallery link.");
				const downloads = provider === "toapis" ? 2 : 1;
				expect(fixtures.requests.filter(({ path }) => path === editedImagePath)).toEqual(
					Array.from({ length: downloads }, () => ({
						path: editedImagePath,
						method: "GET",
						key: null,
					})),
				);
				const statusRequests = fixtures.requests.filter(({ path }) => path.includes("/status/"));
				expect(statusRequests.map(({ path }) => path)).toEqual(
					Array.from({ length: downloads + 1 }, () => fixtures.statusPath),
				);
				await assertPrivate();
				assertOneSubmission();

				await restart();
				const before = fixtures.requests.length;
				const removed = await page.request.post(`${origin}/settings/providers?/remove`, {
					headers: { origin, accept: "text/html" },
					form: { provider, jobWarning: "seen" },
				});
				expect(removed.ok()).toBe(true);
				await page.goto(`${origin}/settings/providers?provider=${provider}`);
				await expect(page.getByText("Disconnected", { exact: true })).toBeVisible();
				await page.goto(`${origin}/gallery`);
				await assertPrivate();
				await page.goto(origin + path);
				await expect(page.getByRole("img", { name: /image from job/i })).toBeVisible();
				const media = await page.request.get(`${origin}${path}/media`);
				expect(media.status()).toBe(200);
				expect(media.headers()).toMatchObject({
					"content-type": "image/png",
					"cache-control": "private, no-store",
				});
				expect(await media.body()).toEqual(editedPng);
				expect(fixtures.requests.slice(before)).toEqual([]);
				await assertPrivate();
			},
		);
	});
}

test("direct edit guards reject invalid scope and stale authorization before any attempt", async ({
	page,
	browser,
}) => {
	await withEditStudio(
		page,
		"toapis",
		"completed",
		async ({ origin, fixtures, post, cacheHome }) => {
			const before = fixtures.requests.length;
			const input = edit("toapis");
			const other = await browser.newContext();
			try {
				for (const route of ["/image/review", "/image/queue"]) {
					const response = await other.request.post(origin + route, {
						headers: { origin },
						data: input,
					});
					expect(response.status()).toBe(401);
				}
			} finally {
				await other.close();
			}
			const review = await readReview(await post("/image/review", input));
			expect(review).toMatchObject({
				requiresConsent: true,
				quote: { status: "known", perRequest: "5.6" },
			});
			const click = { ...input, token: review.token, acceptUnknown: true };
			const invalidScopes = [
				{ ...click, count: 2 },
				{ ...click, retryLimit: 1 },
				{ ...click, layer_decomposition: true },
				{ ...click, draft: { ...input.draft, references: [] } },
				{
					...click,
					draft: {
						...input.draft,
						references: [...input.draft.references, ...input.draft.references],
					},
				},
				{
					...click,
					draft: { ...input.draft, references: [{ kind: "file", file: { name: "private.png" } }] },
				},
				...[
					"not a URL",
					"https://images.example.test/reference.png",
					"https://ipv4only.arpa/reference.png",
					"https://resolver.arpa/reference.png",
					"https://printer.service.arpa/reference.png",
					"https://localhost/reference.png",
					"https://user@example.test/reference.png",
				].map((url) => ({ ...edit("toapis", url), token: review.token, acceptUnknown: true })),
			];
			for (const route of ["/image/review", "/image/queue"]) {
				expect((await post(route, click, "https://elsewhere.example.test")).status()).toBe(403);
				for (const invalid of invalidScopes) {
					expect((await post(route, invalid)).status()).toBe(400);
				}
			}
			expect((await post("/image/queue", { ...click, acceptUnknown: false })).status()).toBe(400);
			expect(
				(
					await post("/image/queue", { ...click, draft: edit("toapis", changedReference).draft })
				).status(),
			).toBe(400);

			// Change the active price evidence while keeping the same draft and credential.
			const cachePath = pricingCachePath(cacheHome, "toapis");
			const cached = await Bun.file(cachePath).json();
			cached.feed.conversionCacheAgeSeconds = 1;
			await Bun.write(cachePath, JSON.stringify(cached));
			const stalePrice = await post("/image/queue", click);
			expect(stalePrice.status()).toBe(409);
			expect(await stalePrice.json()).toMatchObject({
				error: "stale",
				review: { acceptUnknown: false },
			});
			expect(fixtures.requests.slice(before)).toEqual([]);

			const current = await readReview(await post("/image/review", input));
			const disconnected = await page.request.post(`${origin}/settings/providers?/remove`, {
				headers: { origin, accept: "text/html" },
				form: { provider: "toapis" },
			});
			expect(disconnected.ok()).toBe(true);
			const staleCredential = await post("/image/queue", { ...click, token: current.token });
			expect(staleCredential.status()).toBe(409);
			const jobs = await page.goto(`${origin}/jobs`);
			expect(jobs?.ok()).toBe(true);
			await expect(page.getByRole("heading", { name: "No jobs yet" })).toBeVisible();
			expect(fixtures.requests.slice(before)).toEqual([]);
		},
	);
});

for (const [provider, outcome, state, message] of [
	["poyo", "rejected", "Submission rejected", /rejected the request parameters/],
	["toapis", "rejected", "Submission rejected", /rejected the request parameters/],
	["toapis", "failed", "Job failed", /provider could not read the reference/i],
	["toapis", "timeout", "May have been submitted", /Check provider history/],
] as const) {
	test(`${provider} ${outcome} keeps one edit attempt and safe details across restart`, async ({
		page,
	}) => {
		test.setTimeout(60_000);
		await withEditStudio(
			page,
			provider,
			outcome,
			async ({ origin, fixtures, post, restart, assertPrivate, assertOneSubmission }) => {
				const input = edit(provider);
				const review = await readReview(await post("/image/review", input));
				const click = { ...input, token: review.token, acceptUnknown: review.requiresConsent };
				const [first, second] = await Promise.all([
					post("/image/queue", click),
					post("/image/queue", click),
				]);
				expect(first.status()).toBe(200);
				expect(second.status()).toBe(200);
				const accepted = await first.json();
				expect(accepted).toHaveProperty("jobId");
				expect(await second.json()).toEqual(accepted);
				expect(fixtures.submissions).toEqual([providerPayload(provider)]);
				const verifyJob = async () => {
					await page.goto(`${origin}/jobs`);
					const article = page.getByRole("article");
					await expect(article).toHaveCount(1);
					await expect(article.getByText(state, { exact: true })).toBeVisible({ timeout: 20_000 });
					await expect(article.getByText(message)).toBeVisible();
					await assertPrivate();
					assertOneSubmission();
				};
				await verifyJob();
				await restart();
				const replay = await post("/image/queue", click);
				expect(replay.status()).toBe(200);
				expect(await replay.json()).toEqual(accepted);
				await verifyJob();
			},
		);
	});
}
